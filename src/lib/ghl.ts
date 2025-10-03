// src/lib/ghl.ts
const API_VERSION = "2021-07-28";

export type OAuthTokens = {
  access_token: string;
  refresh_token: string;
  scope?: string;
  expires_in: number;
  token_type: string;
  companyId?: string;  // agencyId
  locationId?: string; // sub-account id
};

export const OAUTH_LOG = String(process.env.OAUTH_LOG || "off").toLowerCase() === "on";
export const OAUTH_LOG_PREFIX = "[oauth]";

export function olog(msg: string, details?: unknown) {
  if (!OAUTH_LOG) return;
  try {
    console.info(
      `${OAUTH_LOG_PREFIX} ${msg}`,
      details ? JSON.stringify(details, (_k, v) => (Array.isArray(v) ? v.slice(0, 8) : v)) : "",
    );
  } catch {
    console.info(`${OAUTH_LOG_PREFIX} ${msg}`);
  }
}

export function lcHeaders(accessToken: string, extra?: Record<string, string>) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    Version: API_VERSION,
    ...(extra ?? {}),
  };
}

export function ghlAuthBase() {
  return "https://marketplace.gohighlevel.com/oauth/authorize";
}
export function ghlTokenUrl() {
  return "https://services.leadconnectorhq.com/oauth/token";
}
export function ghlReconnectUrl() {
  return "https://services.leadconnectorhq.com/oauth/reconnect";
}

export function ghlCompanyUrl(companyId: string) {
  return `https://services.leadconnectorhq.com/companies/${companyId}`;
}
export function ghlCompanyLocationsUrl(companyId: string, page = 1, limit = 200) {
  const u = new URL(`https://services.leadconnectorhq.com/companies/${companyId}/locations`);
  u.searchParams.set("page", String(page));
  u.searchParams.set("limit", String(limit));
  return u.toString();
}
export function ghlInstalledLocationsUrl(companyId: string, integrationId: string) {
  const u = new URL(`https://services.leadconnectorhq.com/oauth/installedLocations`);
  u.searchParams.set("companyId", companyId);
  u.searchParams.set("appId", integrationId);
  u.searchParams.set("isInstalled", "true");
  return u.toString();
}
export function ghlMintLocationTokenUrl() {
  return "https://services.leadconnectorhq.com/oauth/locationToken";
}

export function getGhlConfig() {
  const baseApp = process.env.NEXT_PUBLIC_APP_BASE_URL || "http://localhost:3000";
  const redirectPath = process.env.GHL_REDIRECT_PATH || "/api/oauth/callback";
  const redirectUri = `${baseApp}${redirectPath}`;

  return {
    clientId: required("GHL_CLIENT_ID"),
    clientSecret: required("GHL_CLIENT_SECRET"),
    scope: process.env.GHL_SCOPES || "",
    redirectUri,
    baseApp,
    integrationId: process.env.GHL_INTEGRATION_ID || "",
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return String(v);
}

// ---------- Helpers for normalizing LC location payloads ----------
export type AnyLoc = {
  id?: string;
  _id?: string;
  locationId?: string;
  name?: string;
  isInstalled?: boolean;
};
export type LCListLocationsResponse = { locations?: AnyLoc[] } | AnyLoc[];

export function pickLocs(json: unknown): AnyLoc[] {
  if (Array.isArray(json)) return json.filter(isAnyLoc);
  if (isObj(json) && Array.isArray((json as { locations?: unknown }).locations)) {
    const arr = (json as { locations?: unknown }).locations;
    return (arr as unknown[]).filter(isAnyLoc) as AnyLoc[];
  }
  return [];
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
export function isAnyLoc(v: unknown): v is AnyLoc {
  if (!isObj(v)) return false;
  return "id" in v || "locationId" in v || "_id" in v;
}
export function safeId(l: AnyLoc): string | null {
  const cands = [l.id, l.locationId, l._id].map((x) => (typeof x === "string" ? x.trim() : ""));
  const id = cands.find((s) => s && s.length > 0);
  return id ?? null;
}
export function safeName(l: AnyLoc): string | null {
  return typeof l.name === "string" && l.name.trim() ? l.name : null;
}
export function safeInstalled(l: AnyLoc): boolean {
  return Boolean(l.isInstalled);
}

// -----------------------------------------------------------------------------
// Custom Menus
// -----------------------------------------------------------------------------
export function ghlCustomMenusBase() {
  return "https://services.leadconnectorhq.com/custom-menus/"; // NOTE: trailing slash
}

export const CML_SCOPES = {
  READ: "custom-menu-link.readonly",
  WRITE: "custom-menu-link.write",
};

export function scopeListFromTokenScope(scope?: string | null): string[] {
  return (scope || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type CmlIcon =
  | { type: "EMOJI"; value: string }
  | { type: "URL"; value: string };

export type CustomMenu = {
  id?: string;
  title: string;
  url: string;
  placement?: string;
  openMode?: string;
  visibility?: { agency?: boolean; subAccount?: boolean };
  icon?: CmlIcon | { name?: string; fontFamily?: string };
  showOnCompany?: boolean;
  showOnLocation?: boolean;
  showToAllLocations?: boolean;
  userRole?: "admin" | "user" | "all";
};
export type CustomMenuListResponse = CustomMenu[] | { items?: CustomMenu[] };

export async function listCompanyMenus(accessToken: string /*, companyId: string (no longer needed) */) {
  const base = ghlCustomMenusBase(); // -> "https://services.leadconnectorhq.com/custom-menus/"
  const url = base; // No query params; company inferred from token
  const r = await fetch(url, { headers: lcHeaders(accessToken), cache: "no-store" });
  const text = await r.text().catch(() => "");
  if (!r.ok) return { ok: false as const, status: r.status, bodyText: text };
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  const payload = json as CustomMenuListResponse | null;
  const items = payload
    ? Array.isArray(payload)
      ? payload
      : Array.isArray(payload.items)
        ? payload.items
        : []
    : [];
  return { ok: true as const, items };
}

export function findOurMenu(items: CustomMenu[]) {
  return items.find(
    (m) =>
      (m.title || "").toLowerCase() === "driving for dollars" &&
      typeof m.url === "string" &&
      m.url.startsWith("https://app.driving4dollars.co/app"),
  );
}

/**
 * Robust deletion that handles permission quirks.
 */
export async function deleteMenuById(
  agencyAccessToken: string,
  customMenuId: string,
): Promise<boolean> {
  const base = ghlCustomMenusBase();
  const url = `${base}${encodeURIComponent(customMenuId)}`;

  try {
    const r = await fetch(url, {
      method: "DELETE",
      headers: lcHeaders(agencyAccessToken, { "Content-Type": "application/json" }),
    });
    const sample = await r.text().catch(() => "");
    if (r.status === 404) { olog("cml delete -> 404 (treat as success)"); return true; }
    if (r.ok) { olog("cml delete -> success"); return true; }
    olog("cml delete -> failed", { status: r.status, sample: sample.slice(0, 400) });
  } catch (e) {
    olog("cml delete -> error", { err: String(e) });
  }
  return false;
}

// -----------------------------------------------------------------------------
// Reconnect helpers
// -----------------------------------------------------------------------------

export async function reconnectForCompanyAuthCode(
  clientId: string,
  clientSecret: string,
  companyId: string,
): Promise<string | null> {
  try {
    const r = await fetch(ghlReconnectUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ clientKey: clientId, clientSecret, companyId }),
    });
    if (!r.ok) {
      olog("reconnect company failed", { status: r.status, sample: (await r.text().catch(() => "")).slice(0, 300) });
      return null;
    }
    const j = (await r.json()) as { authorizationCode?: string };
    return (j.authorizationCode && j.authorizationCode.trim()) || null;
  } catch (e) {
    olog("reconnect company error", { err: String(e) });
    return null;
  }
}

export async function exchangeAuthCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<OAuthTokens | null> {
  try {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      // IMPORTANT: for company reconnection we explicitly set user_type
      user_type: "Company",
    });
    const r = await fetch(ghlTokenUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form,
    });
    const raw = await r.text();
    if (!r.ok) {
      olog("token exchange (from reconnect code) failed", { status: r.status, sample: raw.slice(0, 400) });
      return null;
    }
    return JSON.parse(raw) as OAuthTokens;
  } catch (e) {
    olog("token exchange error", { err: String(e) });
    return null;
  }
}
