// src/app/api/webhooks/ghl/marketplace/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
import {
  olog,
  getGhlConfig,
  listCompanyMenus,
  findOurMenu,
  deleteMenuById,
  lcHeaders,
  ghlInstalledLocationsUrl,
  pickLocs,
  AnyLoc,
} from "@/lib/ghl";
import { exchangeRefreshToken } from "@/lib/ghlTokens";

export const runtime = "nodejs";

type UninstallPayloadA = { type: "UNINSTALL"; appId?: string; companyId?: string; locationId?: string };
type UninstallPayloadB = { event: "AppUninstall"; appId?: string; companyId?: string; locationId?: string };
type UninstallPayload = UninstallPayloadA | UninstallPayloadB;

async function anyInstalledLocations(agencyId: string): Promise<boolean> {
  const q = await db()
    .collection("locations")
    .where("agencyId", "==", agencyId)
    .where("isInstalled", "==", true)
    .limit(1)
    .get();
  return !q.empty;
}

async function getAgencyIdForLocation(locationId: string): Promise<string | null> {
  const snap = await db().collection("locations").doc(locationId).get();
  return snap.exists ? (String((snap.data() || {}).agencyId || "") || null) : null;
}

async function getAccessTokenForAgency(agencyId: string): Promise<string | null> {
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

  // Fallback: use any location refresh token under the agency
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

async function getAccessTokenForLocation(locationId: string): Promise<string | null> {
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
 * Mark every location in this agency as uninstalled (local source of truth).
 * Keeps refreshToken intact (some teams prefer to null it; if you want that, flip CLEAR_REFRESH to true).
 */
async function markAllAgencyLocationsUninstalled(agencyId: string): Promise<number> {
  const CLEAR_REFRESH = false;
  const col = db().collection("locations");
  const q = await col.where("agencyId", "==", agencyId).select().get();

  let updated = 0;
  const BATCH_LIMIT = 400; // under 500 to be safe with overhead
  let batch = db().batch();
  let countInBatch = 0;

  for (const doc of q.docs) {
    const ref = col.doc(doc.id);
    const data: Record<string, unknown> = { isInstalled: false };
    if (CLEAR_REFRESH) data.refreshToken = null;

    batch.set(ref, data, { merge: true });
    updated++;
    countInBatch++;

    if (countInBatch >= BATCH_LIMIT) {
      await batch.commit();
      batch = db().batch();
      countInBatch = 0;
    }
  }
  if (countInBatch > 0) await batch.commit();
  return updated;
}

/**
 * Authoritative check via /oauth/installedLocations to see if any sub-accounts
 * still have the app installed (only when appId is configured).
 */
async function countInstalledViaApi(agencyId: string): Promise<number | null> {
  const cfg = getGhlConfig();
  if (!cfg.integrationId) return null;

  const acc = await getAccessTokenForAgency(agencyId);
  if (!acc) return null;

  const r = await fetch(ghlInstalledLocationsUrl(agencyId, cfg.integrationId), {
    headers: lcHeaders(acc),
  });
  if (!r.ok) {
    const sample = await r.text().catch(() => "");
    olog("installedLocations check failed", { status: r.status, sample: sample.slice(0, 300) });
    return null;
  }

  const json: unknown = await r.json();
  const arr = pickLocs(json);
  // Only keep valid location ids
  const installed = arr.filter((l: AnyLoc) => !!(l.id || l.locationId || l._id));
  return installed.length;
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

  // Update Firestore install flags
  if (locationId) {
    await db().collection("locations").doc(locationId).set({ isInstalled: false }, { merge: true });
  } else if (agencyId) {
    // Company-level uninstall -> proactively mark ALL agency locations uninstalled
    const changed = await markAllAgencyLocationsUninstalled(agencyId);
    olog("company uninstall: marked sub-accounts uninstalled", { agencyId, changed });
  }

  if (!agencyId) return NextResponse.json({ ok: true }, { status: 200 });

  // If a specific location uninstalled and others still installed, keep the single CML
  if (locationId) {
    const stillAny = await anyInstalledLocations(agencyId);
    if (stillAny) return NextResponse.json({ ok: true, keptMenu: true }, { status: 200 });
  }

  // From here, either:
  //  - company-level uninstall, or
  //  - last remaining location uninstall
  // Try to remove the CML at the company scope so it disappears everywhere.

  // Grab usable access tokens for both contexts to maximize success.
  const agencyAccessToken = await getAccessTokenForAgency(agencyId);
  const locationAccessToken = locationId ? await getAccessTokenForLocation(locationId) : null;

  // If tokens are gone post-uninstall, we still proceed with local cleanup and surface that remote delete is pending.
  if (!agencyAccessToken && !locationAccessToken) {
    await db().collection("agencies").doc(agencyId).set({ customMenuId: null }, { merge: true });
    return NextResponse.json({ ok: true, pendingMenuRemoval: true }, { status: 200 });
  }

  // Resolve the CML id (use known id, else list and find)
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

  // If there's no CML id, nothing to delete remotely.
  if (!menuId) {
    await db().collection("agencies").doc(agencyId).set({ customMenuId: null }, { merge: true });
    return NextResponse.json({ ok: true, notFound: true }, { status: 200 });
  }

  // If company-level uninstall, we can be aggressive and remove the menu now.
  // Otherwise (last location uninstall), remove as well.
  const ok = await deleteMenuById(agencyAccessToken || "", menuId, {
    companyId: agencyId,
    locationAccessToken: locationAccessToken || undefined,
  });

  if (ok) {
    await db().collection("agencies").doc(agencyId).set({ customMenuId: null }, { merge: true });
    return NextResponse.json({ ok: true, removedMenuId: menuId }, { status: 200 });
  }

  // Last resort: confirm via installedLocations. If zero, respond accordingly so
  // your ops can run /maintenance/cleanup-menus later (or you can call it automatically).
  const apiCount = await countInstalledViaApi(agencyId);
  return NextResponse.json(
    { ok: false, apiInstalledCount: apiCount ?? "(unknown)", removalAttempted: true },
    { status: 200 },
  );
}
