// src/app/api/webhooks/ghl/marketplace/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
import {
  olog,
  getGhlConfig,
  listCompanyMenus,
  findOurMenu,
  deleteMenuById,
  reconnectForCompanyAuthCode,
  exchangeAuthCodeForTokens,
} from "@/lib/ghl";
import { exchangeRefreshToken } from "@/lib/ghlTokens";

export const runtime = "nodejs";

type UninstallPayload =
  | { type: "UNINSTALL"; appId?: string; companyId?: string; locationId?: string }
  | { event: "AppUninstall"; appId?: string; companyId?: string; locationId?: string };

function isNonEmpty(s?: string | null): s is string {
  return typeof s === "string" && !!s.trim();
}

// Avoid composite index by scanning a small slice and picking the first token.
async function getAnyLocationAccessTokenForAgency(agencyId: string): Promise<string | null> {
  try {
    const { clientId, clientSecret } = getGhlConfig();
    // Pull up to 50 docs and pick the first with a refresh token.
    const q = await db()
      .collection("locations")
      .where("agencyId", "==", agencyId)
      .limit(50)
      .get();

    for (const d of q.docs) {
      const rt = String((d.data() || {}).refreshToken || "");
      if (!rt) continue;
      try {
        const tok = await exchangeRefreshToken(rt, clientId, clientSecret);
        if (isNonEmpty(tok.access_token)) return tok.access_token!;
      } catch (e) {
        olog("fallback location token exchange failed", { agencyId, locationId: d.id, err: String(e) });
      }
    }
    return null;
  } catch (e) {
    olog("fallback location token scan failed", { agencyId, err: String(e) });
    return null;
  }
}

async function getAgencyAccessTokenOrReconnect(agencyId: string): Promise<string | null> {
  const { clientId, clientSecret, redirectUri } = getGhlConfig();

  // 1) Try stored agency refresh token (may be invalid after uninstall).
  try {
    const agSnap = await db().collection("agencies").doc(agencyId).get();
    const ag = agSnap.exists ? agSnap.data() || {} : {};
    const agencyRefresh = String(ag.refreshToken || "") || "";
    if (agencyRefresh) {
      try {
        const tok = await exchangeRefreshToken(agencyRefresh, clientId, clientSecret);
        if (isNonEmpty(tok.access_token)) return tok.access_token!;
      } catch (e) {
        olog("agency token exchange failed", { agencyId, err: String(e) });
      }
    }
  } catch (e) {
    olog("agency read failed", { agencyId, err: String(e) });
  }

  // 2) If that failed, use the official Reconnect API for companyId -> auth code -> access token
  const code = await reconnectForCompanyAuthCode(clientId, clientSecret, agencyId);
  if (!code) return null;

  const toks = await exchangeAuthCodeForTokens(code, clientId, clientSecret, redirectUri);
  if (!toks?.access_token) return null;
  return toks.access_token;
}

export async function POST(req: Request): Promise<Response> {
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

  const agencyId =
    (payload && "companyId" in payload && typeof payload.companyId === "string" && payload.companyId.trim()) || null;
  const locationId =
    (payload && "locationId" in payload && typeof payload.locationId === "string" && payload.locationId.trim()) || null;

  // Mark the specific location as uninstalled if present.
  if (locationId) {
    await db().collection("locations").doc(locationId).set({ isInstalled: false }, { merge: true });
  }

  if (!agencyId) {
    return NextResponse.json({ ok: true, note: "no companyId on uninstall payload" }, { status: 200 });
  }

  // If this is an AGENCY uninstall (no specific locationId provided),
  // consider all sub-accounts uninstalled and proceed to delete the agency-level menu.
  if (!locationId) {
    // Mark a slice of locations under this agency as uninstalled (best-effort; no composite index).
    try {
      const q = await db().collection("locations").where("agencyId", "==", agencyId).limit(500).get();
      let changed = 0;
      const batch = db().batch();
      for (const d of q.docs) {
        batch.set(d.ref, { isInstalled: false }, { merge: true });
        changed++;
      }
      if (changed) await batch.commit();
      olog("company uninstall: marked sub-accounts uninstalled", { agencyId, changed });
    } catch (e) {
      olog("company uninstall: marking subs failed (non-fatal)", { agencyId, err: String(e) });
    }
  }

  // Acquire a token with permission to delete the company custom menu:
  //  1) try agency refresh -> access; 2) try company reconnect; 3) optional: any location refresh (will still 401 on CML).
  let agencyAccessToken = await getAgencyAccessTokenOrReconnect(agencyId);
  if (!agencyAccessToken) {
    // As a very last resort, try a location access token (likely to 401 on CML endpoints, but we’ll attempt).
    agencyAccessToken = await getAnyLocationAccessTokenForAgency(agencyId);
  }

  if (!agencyAccessToken) {
    // We can’t call Custom Menus — return success to webhook, but flag manual cleanup.
    return NextResponse.json({ ok: true, pendingManualRemoval: true, reason: "no-token" }, { status: 200 });
  }

  // Find the custom menu id (either stored or by listing) then delete it.
  const agSnap = await db().collection("agencies").doc(agencyId).get();
  const knownId = (agSnap.data() || {}).customMenuId as string | undefined;

  let menuId = knownId || "";
  if (!menuId) {
    const list = await listCompanyMenus(agencyAccessToken);
    if (list.ok) {
      const found = findOurMenu(list.items);
      menuId = (found?.id as string | undefined) || "";
    } else {
      olog("list company menus failed", { status: (list as { status?: number }).status });
    }
  }

  if (!menuId) {
    return NextResponse.json({ ok: true, notFound: true }, { status: 200 });
  }

  const ok = await deleteMenuById(agencyAccessToken, menuId);

  if (ok) {
    await db().collection("agencies").doc(agencyId).set({ customMenuId: null }, { merge: true });
  }

  return NextResponse.json({ ok, removedMenuId: ok ? menuId : undefined }, { status: 200 });
}
