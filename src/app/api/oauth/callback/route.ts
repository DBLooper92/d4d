// src/app/api/oauth/callback/route.ts
import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { db } from "@/lib/firebaseAdmin";
import {
  getGhlConfig,
  ghlTokenUrl,
  lcHeaders,
  OAuthTokens,
  olog,
  LCListLocationsResponse,
  pickLocs,
  safeId,
  safeInstalled,
  safeName,
  ghlInstalledLocationsUrl,
  ghlCompanyLocationsUrl,
  ghlMintLocationTokenUrl,
  ghlCustomMenusBase,
  CML_SCOPES,
  scopeListFromTokenScope,
  CustomMenuListResponse,
} from "@/lib/ghl";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

// NOTE: single shape with optional fields (no union), so TS allows accessing both keys safely
type CreateMenuResponse = { id?: string; data?: { id?: string } };

// Ensure a CML exists and return its id if known.
async function ensureCml(
  accessToken: string,
  companyId: string,
  tokenScopes: string[],
): Promise<string | null> {
  const base = ghlCustomMenusBase();

  const hasRead = tokenScopes.includes(CML_SCOPES.READ);
  const hasWrite = tokenScopes.includes(CML_SCOPES.WRITE);
  olog("ensureCml precheck", { companyId, hasWrite, hasRead });
  if (!hasRead || !hasWrite) return null;

  const tryList = async (url: string) => {
    const r = await fetch(url, { headers: lcHeaders(accessToken), cache: "no-store" });
    const text = await r.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* ignore */
    }
    return { ok: r.ok, status: r.status, bodyText: text, json };
  };

  // List (preferred shape)
  const listQueryUrl = `${base}?companyId=${encodeURIComponent(companyId)}`;
  const listResp = await tryList(listQueryUrl);

  if (listResp.ok) {
    const payload = listResp.json as CustomMenuListResponse | null;
    const menus = payload
      ? Array.isArray(payload)
        ? payload
        : Array.isArray(payload.items)
          ? payload.items
          : []
      : [];
    const existing = menus.find(
      (m) =>
        (m.title || "").toLowerCase() === "driving for dollars" &&
        typeof m.url === "string" &&
        m.url.startsWith("https://app.driving4dollars.co/app"),
    );
    if (existing?.id) return existing.id;
    if (existing) return null; // found but missing id shape → don't recreate
  } else {
    olog("ensureCml list failed", { status: listResp.status, sample: (listResp.bodyText || "").slice(0, 400) });
  }

  // Create on base endpoint with ?companyId=... (DO NOT include companyId in JSON body)
  const createUrl = `${base}?companyId=${encodeURIComponent(companyId)}`;

  // Minimal, valid body
  const baseBody = {
    title: "Driving for Dollars",
url: "https://app.driving4dollars.co/app?location_id={{location.id}}&agencyId={{company.id}}&ghl_user_id={{user.id}}&ghl_user_role={{user.role}}&ghl_user_email={{user.email}}",
    showOnCompany: false,
    showOnLocation: true,
    showToAllLocations: true,
    allowCamera: false,
    allowMicrophone: false,
    userRole: "all" as const,
    icon: { fontFamily: "fas", name: "car" as const },
  };

  for (const openMode of ["iframe", "current_tab"] as const) {
    const body = { ...baseBody, openMode };
    const r = await fetch(createUrl, {
      method: "POST",
      headers: { ...lcHeaders(accessToken), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const t = await r.text().catch(() => "");
    if (r.ok) {
      olog("ensureCml create success", { openModeUsed: openMode });
      try {
        const created = JSON.parse(t) as CreateMenuResponse;
        const id = created.id ?? created.data?.id ?? null;
        return typeof id === "string" && id ? id : null;
      } catch {
        return null;
      }
    }
    olog("ensureCml create failed", {
      openModeTried: openMode,
      status: r.status,
      sample: t.slice(0, 500),
    });
  }

  olog("CML create failed", { status: 0, body: "exhausted strategies" });
  return null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") || "";

  const userTypeQueryRaw = url.searchParams.get("user_type") || url.searchParams.get("userType") || "";
  const userTypeForToken =
    userTypeQueryRaw.toLowerCase() === "location"
      ? ("Location" as const)
      : userTypeQueryRaw.toLowerCase() === "company"
        ? ("Company" as const)
        : undefined;

  const state = url.searchParams.get("state") || "";
  const [nonce, rtB64] = state ? state.split("|") : ["", ""];

  const ck = await cookies();
  const cookieNonce = ck.get("d4d_oauth_state")?.value || "";

  const hdrs = await headers();
  const referer = hdrs.get("referer") || "";
  const fromGhl = /gohighlevel\.com|leadconnector/i.test(referer);
  if (state) {
    if (!cookieNonce || cookieNonce !== nonce) {
      olog("state mismatch", { hasCookie: !!cookieNonce, nonceIn: !!nonce });
      return NextResponse.json({ error: "Invalid state" }, { status: 400 });
    }
  } else if (!fromGhl) {
    return NextResponse.json({ error: "Invalid state" }, { status: 400 });
  }

  if (!code) {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }

  const { clientId, clientSecret, redirectUri, baseApp, integrationId } = getGhlConfig();

  // 1) Exchange code → tokens
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  if (userTypeForToken) form.set("user_type", userTypeForToken);

  const tokenResp = await fetch(ghlTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form,
  });

  const raw = await tokenResp.text();
  if (!tokenResp.ok) {
    olog("token exchange failed", { status: tokenResp.status, raw: raw.slice(0, 400) });
    return NextResponse.json({ error: "Token exchange failed" }, { status: 502 });
  }

  let tokens: OAuthTokens;
  try {
    tokens = JSON.parse(raw) as OAuthTokens;
  } catch {
    return NextResponse.json({ error: "Bad token JSON" }, { status: 502 });
  }

  const agencyId = tokens.companyId || null;
  const locationId = tokens.locationId || null;
  const scopeArr = scopeListFromTokenScope(tokens.scope);

  olog("token snapshot", {
    userTypeForToken: userTypeForToken ?? "(none)",
    hasCompanyId: !!agencyId,
    hasLocationId: !!locationId,
  });

  type InstallationTarget = "Company" | "Location";
  const installationTarget: InstallationTarget = locationId ? "Location" : "Company";

  // 2) Upsert agency
  if (agencyId) {
    const agenciesRef = db().collection("agencies").doc(agencyId);
    const snap = await agenciesRef.get();
    const isNewAgency = !snap.exists;

    await agenciesRef.set(
      {
        agencyId,
        provider: "leadconnector",
        scopes: scopeArr,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        installedAt: isNewAgency ? FieldValue.serverTimestamp() : snap.get("installedAt") ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  // 3) If Location install, persist that single location
  if (agencyId && locationId) {
    await db().collection("locations").doc(locationId).set(
      {
        locationId,
        agencyId,
        provider: "leadconnector",
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        isInstalled: true,
        name: null,
        installedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await db().collection("agencies").doc(agencyId).collection("locations").doc(locationId).set(
      {
        locationId,
        agencyId,
        name: null,
        installedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  // 4) Company-level discovery + mint per-location tokens (best effort)
  try {
    if (agencyId && installationTarget === "Company") {
      let locs: Array<{ id: string; name: string | null; isInstalled: boolean }> = [];
      if (integrationId) {
        try {
          const r = await fetch(ghlInstalledLocationsUrl(agencyId, integrationId), {
            headers: lcHeaders(tokens.access_token),
          });
          if (r.ok) {
            const data = (await r.json()) as LCListLocationsResponse;
            const arr = pickLocs(data);
            locs = arr
              .map((e) => ({ id: safeId(e), name: safeName(e), isInstalled: safeInstalled(e) }))
              .filter((x): x is { id: string; name: string | null; isInstalled: boolean } => !!x.id);
            olog("installedLocations discovered", { count: locs.length });
          } else {
            olog("installedLocations failed, will fallback", { status: r.status, body: await r.text().catch(() => "") });
          }
        } catch (e) {
          olog("installedLocations error, will fallback", { err: String(e) });
        }
      }

      if (!locs.length) {
        const limit = 200;
        for (let page = 1; page < 999; page++) {
          const r = await fetch(ghlCompanyLocationsUrl(agencyId, page, limit), {
            headers: lcHeaders(tokens.access_token),
          });
          if (!r.ok) break;
          const j = (await r.json()) as LCListLocationsResponse;
          const arr = pickLocs(j);
          for (const e of arr) {
            const id = safeId(e);
            if (!id) continue;
            locs.push({ id, name: safeName(e), isInstalled: safeInstalled(e) });
          }
          if (arr.length < limit) break;
        }
        olog("company locations fallback", { count: locs.length });
      }

      const batch = db().batch();
      const now = FieldValue.serverTimestamp();
      for (const l of locs) {
        const locRef = db().collection("locations").doc(l.id);
        batch.set(
          locRef,
          {
            locationId: l.id,
            agencyId,
            provider: "leadconnector",
            name: l.name ?? null,
            isInstalled: Boolean(l.isInstalled),
            installedAt: now,
            updatedAt: now,
          },
          { merge: true },
        );

        const agencyLocRef = db().collection("agencies").doc(agencyId).collection("locations").doc(l.id);
        batch.set(
          agencyLocRef,
          {
            locationId: l.id,
            agencyId,
            name: l.name ?? null,
            installedAt: now,
            updatedAt: now,
          },
          { merge: true },
        );
      }
      await batch.commit();

      for (const l of locs) {
        try {
          const resp = await fetch(ghlMintLocationTokenUrl(), {
            method: "POST",
            headers: { ...lcHeaders(tokens.access_token), "Content-Type": "application/json" },
            body: JSON.stringify({ companyId: agencyId, locationId: l.id }),
          });
          if (!resp.ok) {
            const errTxt = await resp.text().catch(() => "");
            olog("mint failed", { locationId: l.id, status: resp.status, body: errTxt.slice(0, 300) });
            continue;
          }
          const body = (await resp.json()) as { data?: { refresh_token?: string }; refresh_token?: string };
          const mintedRefresh = body?.data?.refresh_token ?? body?.refresh_token ?? "";
          if (!mintedRefresh) {
            olog("mint missing refresh_token", { locationId: l.id });
            continue;
          }
          await db().collection("locations").doc(l.id).set(
            { refreshToken: mintedRefresh, isInstalled: true, updatedAt: FieldValue.serverTimestamp() },
            { merge: true },
          );
        } catch (e) {
          olog("mint error (non-fatal)", { locationId: l.id, err: String(e) });
        }
      }
    }
  } catch (e) {
    olog("location discovery/mint error", { message: (e as Error).message });
  }

  // 4.5) Ensure the Custom Menu Link exists for this agency (idempotent) and store its id
  if (agencyId) {
    try {
      const cmlId = await ensureCml(tokens.access_token, agencyId, scopeArr);
      if (cmlId) {
        await db().collection("agencies").doc(agencyId).set(
          { customMenuId: cmlId, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      }
    } catch (e) {
      olog("ensureCml error (non-fatal)", { err: String(e) });
    }
  }

  // 5) Redirect back to UI
  const returnTo = rtB64 ? Buffer.from(rtB64, "base64url").toString("utf8") : `${baseApp}/app`;
  const ui = new URL(returnTo);
  ui.searchParams.set("installed", "1");
  if (agencyId) ui.searchParams.set("agencyId", agencyId);
  if (locationId) ui.searchParams.set("locationId", locationId);

  olog("oauth success", {
    userTypeQuery: userTypeForToken ?? "",
    derivedInstallTarget: installationTarget,
    agencyId,
    locationId,
    scopesCount: scopeArr.length,
    scopes: scopeArr,
    scopeRaw: tokens.scope ?? "",
  });

  return NextResponse.redirect(ui.toString(), { status: 302 });
}
