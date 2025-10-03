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

  const tryExchange = async (rt: string) => {
    try {
      const tok = await exchangeRefreshToken(rt, clientId, clientSecret);
      return tok.access_token || null;
    } catch (e) {
      olog("cleanup: token exchange failed", { agencyId, err: String(e) });
      return null;
    }
  };

  if (agencyRefresh) {
    const acc = await tryExchange(agencyRefresh);
    if (acc) return acc;
  }

  // Fallback: scan a few locations (no composite index)
  const snap = await db().collection("locations").where("agencyId", "==", agencyId).limit(200).get();
  for (const doc of snap.docs) {
    const rt = String((doc.data() || {}).refreshToken || "");
    if (!rt) continue;
    const acc = await tryExchange(rt);
    if (acc) return acc;
  }
  return null;
}

type CleanupBody = { agencyId?: string; force?: boolean };

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
  } catch { /* ignore */ }

  const agencyId = (body.agencyId || url.searchParams.get("agencyId") || "").trim();
  const force = body.force ?? (url.searchParams.get("force") === "1");
  if (!agencyId) return NextResponse.json({ error: "Missing agencyId" }, { status: 400 });

  const cfg = getGhlConfig();

  // Prefer authoritative API if available
  let installedCount = 0;
  let usedApi = false;
  if (cfg.integrationId) {
    const acc = await getAccessTokenForAgency(agencyId);
    if (acc) {
      const r = await fetch(ghlInstalledLocationsUrl(agencyId, cfg.integrationId), { headers: lcHeaders(acc) });
      if (r.ok) {
        const json: unknown = await r.json();
        const arr = pickLocs(json);
        installedCount = arr.length;
        usedApi = true;
      }
    }
  }

  if (!usedApi) {
    // Scan Firestore without composite index
    const snap = await db().collection("locations").where("agencyId", "==", agencyId).limit(500).get();
    installedCount = snap.docs.some((d) => Boolean((d.data() || {}).isInstalled)) ? 1 : 0;
  }

  if (installedCount > 0 && !force) {
    return NextResponse.json({ ok: true, keptMenu: true, installedCount }, { status: 200 });
  }

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

  const ok = await deleteMenuById(acc, menuId, { companyId: agencyId });
  if (ok) await db().collection("agencies").doc(agencyId).set({ customMenuId: null }, { merge: true });

  return NextResponse.json({ ok, removedMenuId: menuId, force }, { status: 200 });
}
