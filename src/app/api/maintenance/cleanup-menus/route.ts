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
  pickLocs,
  reconnectForCompanyAuthCode,
  exchangeAuthCodeForTokens,
} from "@/lib/ghl";
import { exchangeRefreshToken } from "@/lib/ghlTokens";

export const runtime = "nodejs";

/**
 * Obtain a company-scoped access token for an agency.
 * Order of attempts:
 *   1) Stored agency refresh token -> exchange
 *   2) Reconnect API -> authorizationCode -> exchange
 *   3) (Fallback) Scan a few locations' refresh tokens -> exchange (useful for read calls;
 *      often insufficient for company-scoped Custom Menu operations, but we return it anyway)
 */
async function getAccessTokenForAgency(agencyId: string): Promise<string | null> {
  const { clientId, clientSecret, redirectUri } = getGhlConfig();

  // 1) Try stored agency refresh
  try {
    const agSnap = await db().collection("agencies").doc(agencyId).get();
    const ag = agSnap.exists ? (agSnap.data() || {}) : {};
    const agencyRefresh = String(ag.refreshToken || "") || "";
    if (agencyRefresh) {
      try {
        const tok = await exchangeRefreshToken(agencyRefresh, clientId, clientSecret);
        if (tok?.access_token) return tok.access_token;
      } catch (e) {
        olog("cleanup: token exchange failed (agency refresh)", { agencyId, err: String(e) });
      }
    }
  } catch (e) {
    olog("cleanup: read agency failed", { agencyId, err: String(e) });
  }

  // 2) Reconnect API path (best effort)
  try {
    const code = await reconnectForCompanyAuthCode(clientId, clientSecret, agencyId);
    if (code) {
      const toks = await exchangeAuthCodeForTokens(code, clientId, clientSecret, redirectUri);
      if (toks?.access_token) return toks.access_token;
    }
  } catch (e) {
    olog("cleanup: reconnect failed", { agencyId, err: String(e) });
  }

  // 3) Fallback: scan a handful of locations for a token (may not carry company CML perms)
  try {
    const snap = await db().collection("locations").where("agencyId", "==", agencyId).limit(200).get();
    for (const doc of snap.docs) {
      const rt = String((doc.data() || {}).refreshToken || "");
      if (!rt) continue;
      try {
        const tok = await exchangeRefreshToken(rt, clientId, clientSecret);
        if (tok?.access_token) return tok.access_token;
      } catch (e) {
        olog("cleanup: token exchange failed (location refresh)", { agencyId, locationId: doc.id, err: String(e) });
      }
    }
  } catch (e) {
    olog("cleanup: scan locations failed", { agencyId, err: String(e) });
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
  } catch {
    /* ignore body parse; allow querystring-only usage */
  }

  const agencyId = (body.agencyId || url.searchParams.get("agencyId") || "").trim();
  const force = body.force ?? (url.searchParams.get("force") === "1");
  if (!agencyId) return NextResponse.json({ error: "Missing agencyId" }, { status: 400 });

  const cfg = getGhlConfig();

  // Check if any locations are still installed. Prefer authoritative API when possible.
  let installedCount = 0;
  let usedApi = false;

  if (cfg.integrationId) {
    const acc = await getAccessTokenForAgency(agencyId);
    if (acc) {
      try {
        const r = await fetch(ghlInstalledLocationsUrl(agencyId, cfg.integrationId), { headers: lcHeaders(acc) });
        if (r.ok) {
          const json: unknown = await r.json();
          const arr = pickLocs(json);
          installedCount = arr.length;
          usedApi = true;
        } else {
          olog("cleanup: installedLocations failed", { agencyId, status: r.status, body: (await r.text().catch(() => "")).slice(0, 300) });
        }
      } catch (e) {
        olog("cleanup: installedLocations error", { agencyId, err: String(e) });
      }
    }
  }

  if (!usedApi) {
    // Firestore fallback (best-effort without composite index)
    try {
      const snap = await db().collection("locations").where("agencyId", "==", agencyId).limit(500).get();
      installedCount = snap.docs.some((d) => Boolean((d.data() || {}).isInstalled)) ? 1 : 0;
    } catch (e) {
      olog("cleanup: firestore check failed", { agencyId, err: String(e) });
    }
  }

  // If any installs remain and not forcing, keep the menu.
  if (installedCount > 0 && !force) {
    return NextResponse.json({ ok: true, keptMenu: true, installedCount }, { status: 200 });
  }

  // Get a company-scoped access token to manage CML.
  const acc = await getAccessTokenForAgency(agencyId);
  if (!acc) {
    return NextResponse.json({ ok: true, pendingManualRemoval: true, reason: "no-company-token" }, { status: 200 });
  }

  // Try known ID first; otherwise list and find our menu.
  const agSnap = await db().collection("agencies").doc(agencyId).get();
  const knownId = (agSnap.data() || {}).customMenuId as string | undefined;

  let menuId = knownId || "";
  if (!menuId) {
    const list = await listCompanyMenus(acc); // company context inferred from token
    if (list.ok) {
      const found = findOurMenu(list.items);
      menuId = (found?.id as string | undefined) || "";
    } else {
      olog("cleanup: list company menus failed", { agencyId, status: (list as { status?: number }).status });
    }
  }

  if (!menuId) {
    return NextResponse.json({ ok: true, notFound: true }, { status: 200 });
  }

  return NextResponse.json({ ok: true, removedMenuId: menuId, force }, { status: 200 });
}
