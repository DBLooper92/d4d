// src/app/api/webhooks/ghl/marketplace/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
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

type Action = "install" | "uninstall" | null;

function parseAction(p: unknown): { action: Action; type: string; event: string } {
  if (!isObject(p)) return { action: null, type: "", event: "" };
  const rawType = hasKey(p, "type") && isString(p.type) ? p.type : "";
  const rawEvent = hasKey(p, "event") && isString(p.event) ? p.event : "";
  const t = rawType.toLowerCase();
  const e = rawEvent.toLowerCase();
  const isUninstall = t === "uninstall" || e === "appuninstall" || t.includes("uninstall") || e.includes("uninstall");
  const isInstall = !isUninstall && (t === "install" || e === "appinstall" || t.includes("install") || e.includes("install"));
  return { action: isInstall ? "install" : isUninstall ? "uninstall" : null, type: rawType, event: rawEvent };
}

function pickString(obj: unknown, key: string): string {
  if (!isObject(obj)) return "";
  const v = hasKey(obj, key) ? obj[key] : undefined;
  return isString(v) ? v.trim() : "";
}

/**
 * ---- Helpers: chunked Firestore batch + Auth ops
 */
const BATCH_LIMIT = 450; // under 500 to leave headroom

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

/**
 * Get an access token for the agency:
 *  1) Try stored access token
 *  2) Fall back to agency refresh token
 */
async function getAccessTokenForAgency(agencyId: string) {
  const { clientId, clientSecret } = getGhlConfig();
  const agSnap = await db().collection("agencies").doc(agencyId).get();
  const ag = agSnap.exists ? (agSnap.data() || {}) : {};
  const agencyRefresh = String((ag as Record<string, unknown>).refreshToken || "") || "";
  const agencyAccess = String((ag as Record<string, unknown>).accessToken || "") || "";

  const tryExchange = async (rt: string) => {
    try {
      const tok = await exchangeRefreshToken(rt, clientId, clientSecret);
      return tok.access_token || null;
    } catch (e) {
      olog("agency token exchange failed", { agencyId, err: String(e) });
      return null;
    }
  };

  // Try the stored access token first; even if it's near expiry it may still work for a DELETE.
  if (agencyAccess) return agencyAccess;

  if (agencyRefresh) {
    const acc = await tryExchange(agencyRefresh);
    if (acc) return acc;
  }

  return null;
}

/**
 * ---- Soft-deactivate for a single location
 */
async function softDeactivateLocation(locationId: string, agencyId?: string | null) {
  const now = FieldValue.serverTimestamp();
  const locationRef = db().collection("locations").doc(locationId);
  await locationRef.set(
    {
      isInstalled: false,
      active: false,
      activeUpdatedAt: now,
      ghlPlanStatus: "inactive",
      ghlPlanUpdatedAt: now,
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      deactivatedAt: now,
    },
    { merge: true },
  );

  if (agencyId) {
    const agLocRef = db().collection("agencies").doc(agencyId).collection("locations").doc(locationId);
    await agLocRef.set(
      {
        isInstalled: false,
        ghlPlanStatus: "inactive",
        ghlPlanUpdatedAt: now,
        updatedAt: now,
      },
      { merge: true },
    );
  }
}

async function softDeactivateAgency(agencyId: string) {
  const now = FieldValue.serverTimestamp();
  await db()
    .collection("agencies")
    .doc(agencyId)
    .set(
      {
        isInstalled: false,
        active: false,
        activeUpdatedAt: now,
        ghlPlanStatus: "inactive",
        ghlPlanUpdatedAt: now,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        deactivatedAt: now,
      },
      { merge: true },
    );

  const snap = await db().collection("locations").where("agencyId", "==", agencyId).get();
  for (const d of snap.docs) {
    try {
      await softDeactivateLocation(d.id, agencyId);
    } catch (e) {
      olog("softDeactivateLocation failed", { agencyId, locationId: d.id, err: String(e) });
    }
  }
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
  const planId = hasKey(rawObj, "planId") && isString(rawObj.planId) ? rawObj.planId.trim() : "";

  if (!agencyId || locationIds.length === 0) {
    // Company-level install without explicit locations: still upsert agency and capture plan.
    if (agencyId) {
      const now = FieldValue.serverTimestamp();
      const baseAgency: Record<string, unknown> = {
        agencyId,
        provider: "leadconnector",
        isInstalled: true,
        updatedAt: now,
        installedAt: now,
      };
      if (planId) {
        baseAgency.ghlPlanId = planId;
        baseAgency.ghlPlanStatus = "active";
        baseAgency.ghlPlanUpdatedAt = now;
      }
      await db().collection("agencies").doc(agencyId).set(
        baseAgency,
        { merge: true },
      );
      return NextResponse.json({ ok: true, note: "agency-only install captured", agencyId }, { status: 200 });
    }

    olog("install payload ignored (missing ids)", { hasAgency: !!agencyId, count: locationIds.length });
    return NextResponse.json({ ok: true, note: "ignored (no ids)" }, { status: 200 });
  }

  const now = FieldValue.serverTimestamp();

  // 1) Ensure agency doc exists (merge)
  const baseAgency: Record<string, unknown> = {
    agencyId,
    provider: "leadconnector",
    isInstalled: true,
    updatedAt: now,
    installedAt: now,
  };
  if (planId) {
    baseAgency.ghlPlanId = planId;
    baseAgency.ghlPlanStatus = "active";
    baseAgency.ghlPlanUpdatedAt = now;
  }
  await db().collection("agencies").doc(agencyId).set(baseAgency, { merge: true });

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
          ...(planId
            ? {
                ghlPlanId: planId,
                ghlPlanStatus: "active" as const,
                ghlPlanUpdatedAt: now,
              }
            : {}),
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
          ...(planId
            ? {
                ghlPlanId: planId,
                ghlPlanStatus: "active" as const,
                ghlPlanUpdatedAt: now,
              }
            : {}),
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
  const rawText = await req.text();
  let payloadUnknown: unknown;
  try {
    payloadUnknown = rawText ? (JSON.parse(rawText) as unknown) : {};
  } catch {
    console.info("[marketplace] webhook bad json", {
      rawLength: rawText.length,
      rawSample: rawText.slice(0, 200),
    });
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const { action, type, event } = parseAction(payloadUnknown);
  const summary =
    isObject(payloadUnknown)
      ? {
          companyId: hasKey(payloadUnknown, "companyId") && isString(payloadUnknown.companyId)
            ? payloadUnknown.companyId
            : "",
          locationId: hasKey(payloadUnknown, "locationId") && isString(payloadUnknown.locationId)
            ? payloadUnknown.locationId
            : "",
          locationsCount: Array.isArray((payloadUnknown as { locations?: unknown }).locations)
            ? ((payloadUnknown as { locations?: unknown }).locations as unknown[]).length
            : 0,
        }
      : { companyId: "", locationId: "", locationsCount: 0 };

  const planId = pickString(payloadUnknown, "planId");
  const installType = pickString(payloadUnknown, "installType");
  const webhookId = pickString(payloadUnknown, "webhookId");

  console.info("[marketplace] webhook", {
    action: action ?? "unknown",
    type,
    event,
    companyId: summary.companyId,
    locationId: summary.locationId,
    locationsCount: summary.locationsCount,
    planId,
    installType,
    webhookId,
  });

  // ---------- INSTALL ----------
  if (action === "install") {
    return handleInstall(payloadUnknown as InstallPayload);
  }

  // ---------- UNINSTALL ----------
  if (action !== "uninstall") {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const raw = payloadUnknown as Record<string, unknown>;
  const agencyIdFromPayload = readCompanyId(raw) || null;
  const locationIdFromPayload = readLocationId(raw) || null;

  let agencyId: string | null = agencyIdFromPayload;
  const locationId: string | null = locationIdFromPayload;
  if (!agencyId && locationId) agencyId = await getAgencyIdForLocation(locationId);

  // ---- Acquire tokens *before* we change documents ----
  const preAgencyAccessToken = agencyId ? await getAccessTokenForAgency(agencyId) : null;

  // --- CASE A: Location uninstall ---
  if (locationId) {
    try {
      await softDeactivateLocation(locationId, agencyId);
      olog("location deactivate complete", { agencyId, locationId });
    } catch (e) {
      olog("location deactivate failed", { agencyId, locationId, err: String(e) });
      // Continue; we still want to try menu removal below
    }
  }

  if (!agencyId) {
    // No way to determine company context; we already removed local data.
    return NextResponse.json({ ok: true, note: "no agencyId available after location delete" }, { status: 200 });
  }

  const remainingInstalled = await anyInstalledLocations(agencyId);
  // If any locations still have the app, keep the menu (nothing to remove)
  if (remainingInstalled) {
    return NextResponse.json({ ok: true, keptMenu: true }, { status: 200 });
  }

  // No installed locations remain: mark agency inactive
  try {
    await softDeactivateAgency(agencyId);
    olog("agency deactivate complete", { agencyId });
  } catch (e) {
    olog("agency deactivate failed", { agencyId, err: String(e) });
    // continue to try menu removal anyway
  }

  // ---- Custom Menu removal flow (use pre-fetched tokens; do not re-query now)
  const agencyAccessToken = preAgencyAccessToken;

  if (!agencyAccessToken) {
    // We canΓÇÖt auth against CML API; return success so webhook doesnΓÇÖt retry forever.
    // Run maintenance endpoint later to clean up if needed.
    return NextResponse.json({ ok: true, pendingManualRemoval: true }, { status: 200 });
  }

  // Find menu id (known or via list)
  const agSnap = await db().collection("agencies").doc(agencyId).get();
  const knownId = (agSnap.data() || {}).customMenuId as string | undefined;

  let menuId = knownId || "";
  if (!menuId) {
    const list = await listCompanyMenus(agencyAccessToken, agencyId);
    if (list.ok) {
      const found = findOurMenu(list.items);
      menuId = (found?.id as string | undefined) || "";
    } else {
      olog("list company menus failed", { status: list.status });
    }
  }
  if (!menuId) return NextResponse.json({ ok: true, notFound: true }, { status: 200 });

  const ok = await deleteMenuById(agencyAccessToken, menuId, { companyId: agencyId });

  if (ok) {
    await db().collection("agencies").doc(agencyId).set({ customMenuId: null }, { merge: true });
  }

  return NextResponse.json({ ok, removedMenuId: menuId }, { status: 200 });
}

