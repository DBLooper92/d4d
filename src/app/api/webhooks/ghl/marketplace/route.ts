// src/app/api/webhooks/ghl/marketplace/route.ts
import { NextResponse } from "next/server";
import { db, getAdminApp } from "@/lib/firebaseAdmin";
import {
  olog,
  getGhlConfig,
  listCompanyMenus,
  findOurMenu,
  deleteMenuById,
  ghlMintLocationTokenUrl,
  lcHeaders,
} from "@/lib/ghl";
import { exchangeRefreshToken } from "@/lib/ghlTokens";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

/**
 * -------- Incoming payload shapes we handle (lenient) ----------
 */
type CommonKeys = {
  appId?: string;
  companyId?: string; // agencyId
  locationId?: string;
  locations?: string[];
};
type InstallPayload =
  | (CommonKeys & { type: "INSTALL"; event?: string })
  | (CommonKeys & { event: "AppInstall"; type?: string });

type UninstallPayload =
  | (CommonKeys & { type: "UNINSTALL"; event?: string })
  | (CommonKeys & { event: "AppUninstall"; type?: string });


/** Type guards */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function hasKey<T extends string>(
  obj: Record<string, unknown>,
  key: T,
): obj is Record<T, unknown> & Record<string, unknown> {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isInstallPayload(p: unknown): p is InstallPayload {
  if (!isObject(p)) return false;
  const t = hasKey(p, "type") && isString(p.type) ? p.type : "";
  const e = hasKey(p, "event") && isString(p.event) ? p.event : "";
  return t === "INSTALL" || e === "AppInstall";
}
function isUninstallPayload(p: unknown): p is UninstallPayload {
  if (!isObject(p)) return false;
  const t = hasKey(p, "type") && isString(p.type) ? p.type : "";
  const e = hasKey(p, "event") && isString(p.event) ? p.event : "";
  return t === "UNINSTALL" || e === "AppUninstall";
}

/** Safe readers */
function readCompanyId(p: Record<string, unknown>): string {
  const v = hasKey(p, "companyId") ? p.companyId : undefined;
  return isString(v) ? v.trim() : "";
}
function readLocationId(p: Record<string, unknown>): string {
  const v = hasKey(p, "locationId") ? p.locationId : undefined;
  return isString(v) ? v.trim() : "";
}
function readLocations(p: Record<string, unknown>): string[] {
  const v = hasKey(p, "locations") ? p.locations : undefined;
  return isStringArray(v) ? v.map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * ---- Helpers: chunked Firestore batch + Auth ops
 */
const BATCH_LIMIT = 450; // under 500 to leave headroom
const AUTH_DELETE_LIMIT = 1000; // Admin SDK bulk delete limit

async function commitInChunks(ops: Array<(b: FirebaseFirestore.WriteBatch) => void>) {
  let i = 0;
  while (i < ops.length) {
    const slice = ops.slice(i, i + BATCH_LIMIT);
    const batch = db().batch();
    slice.forEach((fn) => fn(batch));
    await batch.commit();
    i += slice.length;
  }
}

async function deleteCollectionByQuery(
  col: FirebaseFirestore.Query,
  pick: (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
    op: (b: FirebaseFirestore.WriteBatch) => void;
    uid?: string | null;
  },
  pageSize = 500,
) {
  const uids: string[] = [];
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  while (true) {
    let q = col.limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    const ops: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];
    for (const d of snap.docs) {
      const { op, uid } = pick(d);
      ops.push(op);
      if (uid && uid.trim()) uids.push(uid.trim());
    }
    await commitInChunks(ops);
    last = snap.docs[snap.docs.length - 1];
  }
  return uids;
}

async function deleteAuthUsersInChunks(uids: string[]) {
  if (!uids.length) return;
  const auth = getAdminApp().auth();
  for (let i = 0; i < uids.length; i += AUTH_DELETE_LIMIT) {
    const chunk = uids.slice(i, i + AUTH_DELETE_LIMIT);
    try {
      const res = await auth.deleteUsers(chunk);
      olog("auth.deleteUsers", {
        count: chunk.length,
        successCount: res.successCount,
        failureCount: res.failureCount,
      });
      if (res.failureCount) {
        const samples = res.errors.slice(0, 5).map((e) => ({ index: e.index, error: String(e.error) }));
        olog("auth.deleteUsers failures", { sample: samples });
      }
    } catch (e) {
      olog("auth.deleteUsers error", { err: String(e), chunkSize: chunk.length });
    }
  }
}

async function anyInstalledLocations(agencyId: string) {
  const q = await db()
    .collection("locations")
    .where("agencyId", "==", agencyId)
    .where("isInstalled", "==", true)
    .limit(1)
    .get();
  return !q.empty;
}

async function getAgencyIdForLocation(locationId: string) {
  const snap = await db().collection("locations").doc(locationId).get();
  return snap.exists ? (String((snap.data() || {}).agencyId || "") || null) : null;
}

async function getAccessTokenForAgency(agencyId: string) {
  const { clientId, clientSecret } = getGhlConfig();
  const agSnap = await db().collection("agencies").doc(agencyId).get();
  const ag = agSnap.exists ? agSnap.data() || {} : {};
  const agencyRefresh = String((ag as Record<string, unknown>).refreshToken || "") || "";

  const tryExchange = async (rt: string) => {
    try {
      const tok = await exchangeRefreshToken(rt, clientId, clientSecret);
      return tok.access_token || null;
    } catch (e) {
      olog("agency token exchange failed", { agencyId, err: String(e) });
      return null;
    }
  };

  if (agencyRefresh) {
    const acc = await tryExchange(agencyRefresh);
    if (acc) return acc;
  }

  // Fallback: any location refresh token under this agency
  const q = await db()
    .collection("locations")
    .where("agencyId", "==", agencyId)
    .where("refreshToken", ">", "")
    .limit(1)
    .get();
  if (!q.empty) {
    const rt = String((q.docs[0].data() || {}).refreshToken || "");
    if (rt) return tryExchange(rt);
  }
  return null;
}

async function getAccessTokenForLocation(locationId: string) {
  const { clientId, clientSecret } = getGhlConfig();
  const snap = await db().collection("locations").doc(locationId).get();
  if (!snap.exists) return null;
  const rt = String((snap.data() || {}).refreshToken || "");
  if (!rt) return null;
  try {
    const tok = await exchangeRefreshToken(rt, clientId, clientSecret);
    return tok.access_token || null;
  } catch (e) {
    olog("location token exchange failed", { locationId, err: String(e) });
    return null;
  }
}

/**
 * ---- Cascade delete for a single location
 */
async function cascadeDeleteLocation(locationId: string, agencyId?: string | null) {
  const ops: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];

  // 1) Membership subcollection → collect UIDs and delete
  const membersCol = db().collection("locations").doc(locationId).collection("users");
  const uidsFromMembers = await deleteCollectionByQuery(membersCol, (doc) => {
    const uid = doc.id;
    const userRef = db().collection("users").doc(uid);
    const locUserRef = doc.ref;
    return {
      op: (b) => {
        b.delete(locUserRef);
        b.delete(userRef);
      },
      uid,
    };
  });

  // 2) Root users fallback
  const rootUsersQuery = db().collection("users").where("locationId", "==", locationId);
  const uidsFromRoot = await deleteCollectionByQuery(rootUsersQuery, (doc) => {
    const uid = doc.id;
    return { op: (b) => b.delete(doc.ref), uid };
  });

  // 3) Agency mirror doc
  if (agencyId) {
    const agLocRef = db().collection("agencies").doc(agencyId).collection("locations").doc(locationId);
    ops.push((b) => b.delete(agLocRef));
  }

  // 4) Location doc
  const locationRef = db().collection("locations").doc(locationId);
  ops.push((b) => b.delete(locationRef));

  await commitInChunks(ops);

  // 5) Delete Auth users
  const allUids = Array.from(new Set([...uidsFromMembers, ...uidsFromRoot]));
  if (allUids.length) {
    await deleteAuthUsersInChunks(allUids);
  }
}

/**
 * ---- Cascade delete for an agency
 */
async function cascadeDeleteAgency(agencyId: string) {
  const baseQuery = db().collection("locations").where("agencyId", "==", agencyId);
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  while (true) {
    let q = baseQuery.limit(300);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    for (const d of snap.docs) {
      const locId = d.id;
      try {
        await cascadeDeleteLocation(locId, agencyId);
      } catch (e) {
        olog("cascadeDeleteLocation failed (agency-level)", { agencyId, locationId: locId, err: String(e) });
      }
    }

    last = snap.docs[snap.docs.length - 1];
  }

  // Finally, delete the agency doc
  const ops: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];
  ops.push((b) => b.delete(db().collection("agencies").doc(agencyId)));
  await commitInChunks(ops);
}

/**
 * -------- INSTALL handling ----------
 * Idempotently upsert location docs and try to mint refresh tokens immediately.
 */
async function handleInstall(payload: InstallPayload) {
  const rawObj = payload as unknown as Record<string, unknown>;
  const agencyId = readCompanyId(rawObj);
  const singleLoc = readLocationId(rawObj);
  const manyLocs = readLocations(rawObj);
  const locationIds = Array.from(new Set([singleLoc, ...manyLocs].filter(Boolean)));

  if (!agencyId || locationIds.length === 0) {
    olog("install payload ignored (missing ids)", { hasAgency: !!agencyId, count: locationIds.length });
    return NextResponse.json({ ok: true, note: "ignored (no ids)" }, { status: 200 });
  }

  const now = FieldValue.serverTimestamp();

  // 1) Ensure agency doc exists (merge)
  await db().collection("agencies").doc(agencyId).set(
    {
      agencyId,
      provider: "leadconnector",
      updatedAt: now,
    },
    { merge: true },
  );

  // 2) Upsert locations (without refreshToken yet)
  const ops: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];
  for (const locId of locationIds) {
    const locRef = db().collection("locations").doc(locId);
    const agLocRef = db().collection("agencies").doc(agencyId).collection("locations").doc(locId);

    ops.push((b) =>
      b.set(
        locRef,
        {
          locationId: locId,
          agencyId,
          provider: "leadconnector",
          isInstalled: true,
          updatedAt: now,
          installedAt: now,
        },
        { merge: true },
      ),
    );

    ops.push((b) =>
      b.set(
        agLocRef,
        {
          locationId: locId,
          agencyId,
          updatedAt: now,
          installedAt: now,
        },
        { merge: true },
      ),
    );
  }
  await commitInChunks(ops);

  // 3) Try minting refresh tokens for each location (best-effort)
  const agencyAccess = await getAccessTokenForAgency(agencyId);
  if (!agencyAccess) {
    olog("install: no agency access token to mint", { agencyId, locations: locationIds.length });
    return NextResponse.json({ ok: true, minted: 0 }, { status: 200 });
  }

  let minted = 0;
  for (const locId of locationIds) {
    try {
      const resp = await fetch(ghlMintLocationTokenUrl(), {
        method: "POST",
        headers: { ...lcHeaders(agencyAccess), "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: agencyId, locationId: locId }),
      });
      const txt = await resp.text().catch(() => "");
      if (!resp.ok) {
        olog("install: mint failed", { agencyId, locationId: locId, status: resp.status, sample: txt.slice(0, 300) });
        continue;
      }
      let mintedRefresh = "";
      try {
        const j = JSON.parse(txt) as { data?: { refresh_token?: string }; refresh_token?: string };
        mintedRefresh = j?.data?.refresh_token ?? j?.refresh_token ?? "";
      } catch {
        /* ignore parse errors */
      }

      if (mintedRefresh) {
        await db().collection("locations").doc(locId).set(
          { refreshToken: mintedRefresh, isInstalled: true, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        minted++;
      } else {
        olog("install: mint missing refresh_token", { agencyId, locationId: locId });
      }
    } catch (e) {
      olog("install: mint error", { agencyId, locationId: locId, err: String(e) });
    }
  }

  return NextResponse.json({ ok: true, agencyId, locations: locationIds.length, minted }, { status: 200 });
}

export async function POST(req: Request) {
  let payloadUnknown: unknown;
  try {
    payloadUnknown = (await req.json()) as unknown;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  // ---------- INSTALL ----------
  if (isInstallPayload(payloadUnknown)) {
    return handleInstall(payloadUnknown);
  }

  // ---------- UNINSTALL ----------
  if (!isUninstallPayload(payloadUnknown)) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const raw = payloadUnknown as Record<string, unknown>;
  const agencyIdFromPayload = readCompanyId(raw) || null;
  const locationIdFromPayload = readLocationId(raw) || null;

  let agencyId: string | null = agencyIdFromPayload;
  const locationId: string | null = locationIdFromPayload;
  if (!agencyId && locationId) agencyId = await getAgencyIdForLocation(locationId);

  // --- CASE A: Location uninstall ---
  if (locationId) {
    try {
      await db().collection("locations").doc(locationId).set({ isInstalled: false }, { merge: true });
      await cascadeDeleteLocation(locationId, agencyId);
      olog("location cascade delete complete", { agencyId, locationId });
    } catch (e) {
      olog("location cascade delete failed", { agencyId, locationId, err: String(e) });
    }
  }

  if (!agencyId) {
    return NextResponse.json({ ok: true, note: "no agencyId available after location delete" }, { status: 200 });
  }

  // If any locations still have the app, keep the menu
  if (await anyInstalledLocations(agencyId)) {
    return NextResponse.json({ ok: true, keptMenu: true }, { status: 200 });
  }

  // --- CASE B: Agency uninstall (company-level) OR last location removed ---
  if (!locationId) {
    try {
      await cascadeDeleteAgency(agencyId);
      olog("agency cascade delete complete", { agencyId });
    } catch (e) {
      olog("agency cascade delete failed", { agencyId, err: String(e) });
      // continue to try menu removal anyway
    }
  }

  // ---- Custom Menu removal flow
  const agencyAccessToken = await getAccessTokenForAgency(agencyId);
  const locationAccessToken = locationId ? await getAccessTokenForLocation(locationId) : null;

  if (!agencyAccessToken && !locationAccessToken) {
    return NextResponse.json({ ok: true, pendingManualRemoval: true }, { status: 200 });
  }

  // Find menu id (known or via list)
  const agSnap = await db().collection("agencies").doc(agencyId).get();
  const knownId = (agSnap.data() || {}).customMenuId as string | undefined;

  let menuId = knownId || "";
  if (!menuId) {
    const listToken = agencyAccessToken || locationAccessToken!;
    const list = await listCompanyMenus(listToken, agencyId);
    if (list.ok) {
      const found = findOurMenu(list.items);
      menuId = (found?.id as string | undefined) || "";
    } else {
      olog("list company menus failed", { status: list.status });
    }
  }
  if (!menuId) return NextResponse.json({ ok: true, notFound: true }, { status: 200 });

  const ok = await deleteMenuById(agencyAccessToken || "", menuId, {
    companyId: agencyId,
    locationAccessToken: locationAccessToken || undefined,
  });

  if (ok) {
    await db().collection("agencies").doc(agencyId).set({ customMenuId: null }, { merge: true });
  }

  return NextResponse.json({ ok, removedMenuId: menuId }, { status: 200 });
}
