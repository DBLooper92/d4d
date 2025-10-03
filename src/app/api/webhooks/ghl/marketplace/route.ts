// File: src/app/api/webhooks/ghl/marketplace/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
import { olog, getGhlConfig, listCompanyMenus, findOurMenu, deleteMenuById } from "@/lib/ghl";
import { exchangeRefreshToken } from "@/lib/ghlTokens";

export const runtime = "nodejs";

type UninstallPayload =
  | { type: "UNINSTALL"; appId?: string; companyId?: string; locationId?: string }
  | { event: "AppUninstall"; appId?: string; companyId?: string; locationId?: string };

/**
 * ---- Helpers: chunked Firestore batch ops
 */
const BATCH_LIMIT = 450; // under 500 to leave headroom for metadata ops

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
  pickOp: (doc: FirebaseFirestore.QueryDocumentSnapshot) => (b: FirebaseFirestore.WriteBatch) => void,
  pageSize = 500,
) {
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  // Loop pages until empty
  while (true) {
    let q = col.limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    const ops = snap.docs.map((d) => pickOp(d));
    await commitInChunks(ops);
    last = snap.docs[snap.docs.length - 1];
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
  const agencyRefresh = String(ag.refreshToken || "") || "";

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
 * Deletes:
 *   - locations/{locationId}/users/*  (subcollection)
 *   - users/{uid} for each member referencing the location
 *   - root users where locationId == {locationId} (fallback if subcollection missing)
 *   - agencies/{agencyId}/locations/{locationId}
 *   - locations/{locationId}
 */
async function cascadeDeleteLocation(locationId: string, agencyId?: string | null) {
  const ops: Array<(b: FirebaseFirestore.WriteBatch) => void> = [];

  // 1) Delete membership subcollection & root users
  const membersCol = db().collection("locations").doc(locationId).collection("users");
  // Page through subcollection; collect delete ops for both the subdoc and root user doc
  // We prefer subcollection as source of truth for "associated users".
  await deleteCollectionByQuery(membersCol, (doc) => {
    const uid = doc.id;
    const userRef = db().collection("users").doc(uid);
    const locUserRef = doc.ref;
    return (b) => {
      b.delete(locUserRef);
      b.delete(userRef);
    };
  });

  // 2) Fallback: delete any root users that still point at this location (if any)
  const rootUsersQuery = db().collection("users").where("locationId", "==", locationId);
  await deleteCollectionByQuery(rootUsersQuery, (doc) => (b) => b.delete(doc.ref));

  // 3) Delete agency subcollection mirror doc (if agency known)
  if (agencyId) {
    const agLocRef = db().collection("agencies").doc(agencyId).collection("locations").doc(locationId);
    ops.push((b) => b.delete(agLocRef));
  }

  // 4) Delete the location doc itself
  const locationRef = db().collection("locations").doc(locationId);
  ops.push((b) => b.delete(locationRef));

  await commitInChunks(ops);
}

/**
 * ---- Cascade delete for an agency
 * Deletes:
 *   - For each location in agency: cascadeDeleteLocation(...)
 *   - agencies/{agencyId}
 */
async function cascadeDeleteAgency(agencyId: string) {
  // Page through locations for the agency
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

export async function POST(req: Request) {
  let payload: UninstallPayload | null = null;
  try {
    payload = (await req.json()) as UninstallPayload;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const isUninstall =
    !!payload &&
    (("type" in payload && payload.type === "UNINSTALL") ||
      ("event" in payload && payload.event === "AppUninstall"));
  if (!isUninstall) return NextResponse.json({ ok: true }, { status: 200 });

  const agencyIdFromPayload =
    payload && "companyId" in payload && typeof payload.companyId === "string" ? payload.companyId : null;
  const locationIdFromPayload =
    payload && "locationId" in payload && typeof payload.locationId === "string" ? payload.locationId : null;

  let agencyId: string | null = agencyIdFromPayload;
  const locationId: string | null = locationIdFromPayload;
  if (!agencyId && locationId) agencyId = await getAgencyIdForLocation(locationId);

  // --- CASE A: Location uninstall ---
  if (locationId) {
    try {
      // If you previously flagged isInstalled, we don't need it anymore because we're deleting the doc;
      // but keep this write harmless for logs/consistency in case other code relies on it mid-flight.
      await db().collection("locations").doc(locationId).set({ isInstalled: false }, { merge: true });

      await cascadeDeleteLocation(locationId, agencyId);
      olog("location cascade delete complete", { agencyId, locationId });
    } catch (e) {
      olog("location cascade delete failed", { agencyId, locationId, err: String(e) });
      // We still proceed to menu logic below (it checks remaining installs)
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
  // If company-level uninstall (no locationId in payload), we also nuke all data for this agency.
  if (!locationId) {
    try {
      await cascadeDeleteAgency(agencyId);
      olog("agency cascade delete complete", { agencyId });
    } catch (e) {
      olog("agency cascade delete failed", { agencyId, err: String(e) });
      // continue to try menu removal anyway
    }
  }

  // ---- Custom Menu removal (unchanged flow, but now always runs when no installs remain)
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
