// File: src/app/api/oauth/callback/route.ts
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

export const runtime = "nodejs"; // Node APIs for crypto/cookies

/**
 * Ensure a Custom Menu Link exists for this agency.
 * Router quirks handled:
 * - LIST via GET /custom-menus?companyId=...
 * - CREATE via POST /custom-menus (base endpoint) with new schema
 *   required booleans + allowCamera/allowMicrophone
 *   icon as { name, fontFamily } (try a few families)
 *   userRole: try "all" then "admin"/"user"
 *   openMode: try "iframe" then "current_tab"
 * - LAST RESORT: nested POST /custom-menus/companies/{companyId} with same schema (many tenants 404 here)
 */
async function ensureCml(accessToken: string, companyId: string, tokenScopes: string[]) {
  const base = ghlCustomMenusBase();

  const hasRead = tokenScopes.includes(CML_SCOPES.READ);
  const hasWrite = tokenScopes.includes(CML_SCOPES.WRITE);

  olog("ensureCml precheck", { companyId, hasWrite, hasRead });
  if (!hasRead || !hasWrite) return;

  // helper: GET menus for a given URL
  const tryList = async (url: string) => {
    const r = await fetch(url, { headers: lcHeaders(accessToken), cache: "no-store" });
    const text = await r.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { ok: r.ok, status: r.status, bodyText: text, json };
  };

  // List (preferred shape)
  const listQueryUrl = `${base}?companyId=${encodeURIComponent(companyId)}`;
  let listResp = await tryList(listQueryUrl);

  // Some older routers only expose nested read; try as a fallback (best-effort)
  if (!listResp.ok && listResp.status === 404) {
    const listNestedUrl = `${base}companies/${encodeURIComponent(companyId)}`;
    olog("ensureCml list 404; retrying alternate", { url: listNestedUrl });
    listResp = await tryList(listNestedUrl);
  }

  if (listResp.ok) {
    const payload = listResp.json as CustomMenuListResponse | null;
    const menus = payload
      ? Array.isArray(payload)
        ? payload
        : Array.isArray(payload.items)
          ? payload.items
          : []
      : [];
    const exists = menus.some(
      (m) =>
        (m.title || "").toLowerCase() === "driving for dollars" &&
        typeof m.url === "string" &&
        m.url.startsWith("https://app.driving4dollars.co/app")
    );
    if (exists) return; // already present
  } else {
    olog("ensureCml list failed", { status: listResp.status, sample: (listResp.bodyText || "").slice(0, 400) });
    // continue to create anyway
  }

  // ── Create attempts on BASE endpoint ────────────────────────────────────────
  const createUrl = base;

  // Try several icon families/names that commonly exist across tenants
const iconAttempts = [
  { fontFamily: "fas", name: "car" }, // Font Awesome Solid
  { fontFamily: "fab", name: "car" }, // Font Awesome Brands
  { fontFamily: "far", name: "car" }, // Font Awesome Regular
] as const;

  const userRoleAttempts = ["all", "admin", "user"] as const;
  const openModeAttempts = ["iframe", "current_tab"] as const;

  // Base (shared) fields required y validator
  const baseFields = {
    title: "Driving for Dollars",
    url: "https://app.driving4dollars.co/app?location_id={{location.id}}",
    showOnCompany: false,
    showOnLocation: true,
    showToAllLocations: true,
    allowCamera: false,
    allowMicrophone: false,
  };

  // Try a small matrix: icon × userRole × openMode
  for (const icon of iconAttempts) {
    let iconWorked = false;
    for (const userRole of userRoleAttempts) {
      for (const mode of openModeAttempts) {
        const body = { ...baseFields, icon, userRole, openMode: mode };
        const r = await fetch(createUrl, {
          method: "POST",
          headers: { ...lcHeaders(accessToken), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const t = await r.text().catch(() => "");

        if (r.ok) {
          olog("ensureCml create success", { icon, userRole, openModeUsed: mode });
          return;
        }

        olog("ensureCml base-create attempt failed", {
          icon,
          userRole,
          openModeTried: mode,
          status: r.status,
          sample: t.slice(0, 500),
        });

        if (r.status === 422 && /font family/i.test(t)) {
          // current icon family rejected; move to next icon
          iconWorked = false;
          break;
        }
        // otherwise continue trying other combinations
      }
      if (iconWorked) break;
    }
    // proceed to next iconAttempt
  }

  // ── LAST RESORT: nested create with same schema (many tenants 404 here) ────
  const nestedCreateUrl = `${base}companies/${encodeURIComponent(companyId)}`;
  for (const icon of iconAttempts) {
    let iconWorked = false;
    for (const userRole of userRoleAttempts) {
      for (const mode of openModeAttempts) {
        const body = { ...baseFields, icon, userRole, openMode: mode };
        const r = await fetch(nestedCreateUrl, {
          method: "POST",
          headers: { ...lcHeaders(accessToken), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const t = await r.text().catch(() => "");
        if (r.ok) {
          olog("ensureCml nested-create success", { icon, userRole, openModeUsed: mode });
          return;
        }
        olog("ensureCml nested-create attempt failed", {
          icon,
          userRole,
          openModeTried: mode,
          status: r.status,
          sample: t.slice(0, 500),
        });
        if (r.status === 422 && /font family/i.test(t)) {
          iconWorked = false;
          break;
        }
      }
      if (iconWorked) break;
    }
  }

  // If we got here, creation failed in all shapes.
  olog("CML create failed", { status: 0, body: "exhausted all create strategies (base + nested) with icon/userRole/openMode matrix" });
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
      { merge: true }
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
      { merge: true }
    );

    await db()
      .collection("agencies")
      .doc(agencyId)
      .collection("locations")
      .doc(locationId)
      .set(
        {
          locationId,
          agencyId,
          name: null,
          installedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
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
          { merge: true }
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
          { merge: true }
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

          const body = (await resp.json()) as {
            data?: { refresh_token?: string };
            refresh_token?: string;
          };

          const mintedRefresh = body?.data?.refresh_token ?? body?.refresh_token ?? "";
          if (!mintedRefresh) {
            olog("mint missing refresh_token", { locationId: l.id });
            continue;
          }

          await db().collection("locations").doc(l.id).set(
            {
              refreshToken: mintedRefresh,
              isInstalled: true,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } catch (e) {
          olog("mint error (non-fatal)", { locationId: l.id, err: String(e) });
        }
      }
    }
  } catch (e) {
    olog("location discovery/mint error", { message: (e as Error).message });
  }

  // 4.5) Ensure the Custom Menu Link exists for this agency (idempotent)
  if (agencyId) {
    try {
      await ensureCml(tokens.access_token, agencyId, scopeArr);
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

  // ⬇️ LOG EVERYTHING (no truncation)
  olog("oauth success", {
    userTypeQuery: userTypeForToken ?? "",
    derivedInstallTarget: installationTarget,
    agencyId,
    locationId,
    scopesCount: scopeArr.length,
    scopes: scopeArr,             // <- full list
    scopeRaw: tokens.scope ?? "", // <- raw string, exactly as returned
  });

  return NextResponse.redirect(ui.toString(), { status: 302 });

}
