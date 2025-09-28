// src/app/api/maintenance/cleanup-menus/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
import {
  getGhlConfig,
  olog,
  ghlInstalledLocationsUrl,
  lcHeaders,
  listCompanyMenus,
  findOurMenu,
  deleteMenuById,
  pickLocs,
} from "@/lib/ghl";
import { exchangeRefreshToken } from "@/lib/ghlTokens";

export const runtime = "nodejs";

async function getAccessTokenForAgency(agencyId: string) {
  const { clientId, clientSecret } = getGhlConfig();
  const agSnap = await db().collection("agencies").doc(agencyId).get();
  const ag = agSnap.exists ? (agSnap.data() || {}) : {};
  const agencyRefresh = String(ag.refreshToken || "") || "";
  if (!agencyRefresh) return null;
  try {
    const tok = await exchangeRefreshToken(agencyRefresh, clientId, clientSecret);
    return tok.access_token || null;
  } catch (e) {
    olog("cleanup: token exchange failed", { agencyId, err: String(e) });
    return null;
  }
}

type CleanupBody = { agencyId?: string };

export async function POST(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const adminToken = process.env.ADMIN_MAINT_TOKEN || "";
  if (!adminToken || token !== adminToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CleanupBody = {};
  try {
    body = (await req.json()) as CleanupBody;
  } catch {
    /* ignore body */
  }
  const agencyId = (body.agencyId || url.searchParams.get("agencyId") || "").trim();
  if (!agencyId) return NextResponse.json({ error: "Missing agencyId" }, { status: 400 });

  const cfg = getGhlConfig();

  // 1) Quick check: Firestore—any installed locations?
  const q = await db()
    .collection("locations")
    .where("agencyId", "==", agencyId)
    .where("isInstalled", "==", true)
    .limit(1)
    .get();
  let installedCount = q.size;

  // 2) If appId configured, confirm via installedLocations API (authoritative)
  if (cfg.integrationId) {
    const acc = await getAccessTokenForAgency(agencyId);
    if (acc) {
      const r = await fetch(ghlInstalledLocationsUrl(agencyId, cfg.integrationId), {
        headers: lcHeaders(acc),
      });
      if (r.ok) {
        const json: unknown = await r.json();
        // Normalize via shared helper (avoids any)
        const arr = pickLocs(json);
        installedCount = arr.length;
      }
    }
  }

  if (installedCount > 0) {
    return NextResponse.json({ ok: true, keptMenu: true, installedCount }, { status: 200 });
  }

  // 3) No installs remain → delete the menu
  const acc = await getAccessTokenForAgency(agencyId);
  if (!acc) return NextResponse.json({ ok: true, pendingManualRemoval: true }, { status: 200 });

  const agSnap = await db().collection("agencies").doc(agencyId).get();
  const knownId = (agSnap.data() || {}).customMenuId as string | undefined;

  let menuId = knownId || "";
  if (!menuId) {
    const list = await listCompanyMenus(acc, agencyId);
    if (list.ok) {
      const found = findOurMenu(list.items);
      menuId = (found?.id as string | undefined) || "";
    }
  }
  if (!menuId) return NextResponse.json({ ok: true, notFound: true }, { status: 200 });

  const ok = await deleteMenuById(acc, menuId);
  if (ok) await db().collection("agencies").doc(agencyId).set({ customMenuId: null }, { merge: true });

  return NextResponse.json({ ok, removedMenuId: menuId }, { status: 200 });
}
