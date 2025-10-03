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

/**
 * Single-field query (no composite index). Checks up to 500 docs for isInstalled.
 * Return value is explicit on all paths.
 */
async function anyInstalledLocations(agencyId: string): Promise<boolean> {
  const snap = await db()
    .collection("locations")
    .where("agencyId", "==", agencyId)
    .limit(500)
    .get();

  const any = snap.docs.some((doc) => Boolean((doc.data() || {}).isInstalled));
  return any;
}

/**
 * Resolve agency access token without composite index:
 * 1) Try agency refresh token on /agencies/{agencyId}
 * 2) Fallback: scan up to 200 locations (agencyId filter only) and use first refreshToken found
 */
async function getAccessTokenForAgency(agencyId: string): Promise<string | null> {
  const { clientId, clientSecret } = getGhlConfig();

  // 1) Agency-level refresh token
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

  // 2) Fallback: scan a few locations (no composite index)
  const snap = await db().collection("locations").where("agencyId", "==", agencyId).limit(200).get();
  for (const doc of snap.docs) {
    const rt = String((doc.data() || {}).refreshToken || "");
    if (!rt) continue;
    const acc = await tryExchange(rt);
    if (acc) return acc;
  }

  return null;
}

async function getAgencyIdForLocation(locationId: string): Promise<string | null> {
  const snap = await db().collection("locations").doc(locationId).get();
  return snap.exists ? (String((snap.data() || {}).agencyId || "") || null) : null;
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
 */
async function markAllAgencyLocationsUninstalled(agencyId: string): Promise<number> {
  const CLEAR_REFRESH = false; // set true if you also want to null out refreshToken
  const col = db().collection("locations");
  const q = await col.where("agencyId", "==", agencyId).select().get();

  let updated = 0;
  const BATCH_LIMIT = 400;
  let batch = db().batch();
  let count = 0;

  for (const doc of q.docs) {
    const ref = col.doc(doc.id);
    const data: Record<string, unknown> = { isInstalled: false };
    if (CLEAR_REFRESH) data.refreshToken = null;
    batch.set(ref, data, { merge: true });
    updated++;
    count++;
    if (count >= BATCH_LIMIT) {
      await batch.commit();
      batch = db().batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
  return updated;
}

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
  const installed = arr.filter((l: AnyLoc) => !!(l.id || l.locationId || l._id));
  return installed.length;
}

export async function POST(req: Request) {
  try {
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

    // Mark local state
    if (locationId) {
      await db().collection("locations").doc(locationId).set({ isInstalled: false }, { merge: true });
    } else if (agencyId) {
      const changed = await markAllAgencyLocationsUninstalled(agencyId);
      olog("company uninstall: marked sub-accounts uninstalled", { agencyId, changed });
    }

    if (!agencyId) return NextResponse.json({ ok: true }, { status: 200 });

    // If this was a single-location uninstall and others still installed, keep the menu.
    if (locationId) {
      const stillAny = await anyInstalledLocations(agencyId);
      if (stillAny) return NextResponse.json({ ok: true, keptMenu: true }, { status: 200 });
    }

    // Otherwise (company uninstall, or last location): remove CML at company scope.
    const agencyAccessToken = await getAccessTokenForAgency(agencyId);
    const locationAccessToken = locationId ? await getAccessTokenForLocation(locationId) : null;

    if (!agencyAccessToken && !locationAccessToken) {
      await db().collection("agencies").doc(agencyId).set({ customMenuId: null }, { merge: true });
      return NextResponse.json({ ok: true, pendingMenuRemoval: true }, { status: 200 });
    }

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

    if (!menuId) {
      await db().collection("agencies").doc(agencyId).set({ customMenuId: null }, { merge: true });
      return NextResponse.json({ ok: true, notFound: true }, { status: 200 });
    }

    const ok = await deleteMenuById(agencyAccessToken || "", menuId, {
      companyId: agencyId,
      locationAccessToken: locationAccessToken || undefined,
    });

    if (ok) {
      await db().collection("agencies").doc(agencyId).set({ customMenuId: null }, { merge: true });
      return NextResponse.json({ ok: true, removedMenuId: menuId }, { status: 200 });
    }

    const apiCount = await countInstalledViaApi(agencyId);
    return NextResponse.json(
      { ok: false, apiInstalledCount: apiCount ?? "(unknown)", removalAttempted: true },
      { status: 200 },
    );
  } catch (e) {
    // Never 500 on uninstall webhooks; log and return 200 so Marketplace doesn’t retry forever
    olog("uninstall webhook error (soft)", { err: (e as Error).message });
    return NextResponse.json({ ok: true, softError: true }, { status: 200 });
  }
}
