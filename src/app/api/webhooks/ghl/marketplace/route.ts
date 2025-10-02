// src/app/api/webhooks/ghl/marketplace/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
import { olog, getGhlConfig, listCompanyMenus, findOurMenu, deleteMenuById } from "@/lib/ghl";
import { exchangeRefreshToken } from "@/lib/ghlTokens";

export const runtime = "nodejs";

type UninstallPayload =
  | { type: "UNINSTALL"; appId?: string; companyId?: string; locationId?: string }
  | { event: "AppUninstall"; appId?: string; companyId?: string; locationId?: string };

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

  if (locationId) {
    await db().collection("locations").doc(locationId).set({ isInstalled: false }, { merge: true });
  }
  if (!agencyId) return NextResponse.json({ ok: true }, { status: 200 });

  // If *any* locations still have the app, keep the menu
  if (locationId) {
    const stillAny = await anyInstalledLocations(agencyId);
    if (stillAny) return NextResponse.json({ ok: true, keptMenu: true }, { status: 200 });
  }

  // Get tokens for both contexts so we can try both if needed
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

  // Robust delete covering API and permission quirks
  const ok = await deleteMenuById(agencyAccessToken || "", menuId, {
    companyId: agencyId,
    locationAccessToken: locationAccessToken || undefined,
  });

  if (ok) {
    await db().collection("agencies").doc(agencyId).set({ customMenuId: null }, { merge: true });
  }

  return NextResponse.json({ ok }, { status: 200 });
}
