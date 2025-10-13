// src/lib/ghl.ts
const API_VERSION = "2021-07-28";

export type OAuthTokens = {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;

  // Context
  userType?: "Company" | "Location";
  companyId?: string;          // present for both Company/Location tokens
  locationId?: string | null;  // present when userType is Location (or minted location token)
  userId?: string | null;      // <-- add this (present in token response; ID of the installer/current user)
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

export async function listCompanyMenus(accessToken: string, companyId: string) {
  const base = ghlCustomMenusBase();
  const url = `${base}?companyId=${encodeURIComponent(companyId)}`;
  const r = await fetch(url, { headers: lcHeaders(accessToken), cache: "no-store" });
  const text = await r.text().catch(() => "");
  if (!r.ok) return { ok: false as const, status: r.status, bodyText: text };
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* ignore */ }
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
      m.url.startsWith("https://admin.driving4dollars.co/app"),
  );
}

/**
 * Robust deletion that handles permission quirks.
 */
export async function deleteMenuById(
  agencyAccessToken: string,
  customMenuId: string,
  opts?: { companyId?: string; locationAccessToken?: string },
): Promise<boolean> {
  const base = ghlCustomMenusBase();
  const path = `${base}${encodeURIComponent(customMenuId)}`;
  const withCo = opts?.companyId ? `${path}?companyId=${encodeURIComponent(opts.companyId)}` : null;

  const attempts: Array<{ url: string; token: string; label: string }> = [
    { url: path, token: agencyAccessToken, label: "agency-noCompany" },
    ...(withCo ? [{ url: withCo, token: agencyAccessToken, label: "agency-withCompany" } as const] : []),
    ...(opts?.locationAccessToken ? [{ url: path, token: opts.locationAccessToken, label: "location-noCompany" } as const] : []),
    ...(opts?.locationAccessToken && withCo
      ? [{ url: withCo, token: opts.locationAccessToken, label: "location-withCompany" } as const]
      : []),
  ];

  for (const a of attempts) {
    try {
      const r = await fetch(a.url, {
        method: "DELETE",
        headers: lcHeaders(a.token, { "Content-Type": "application/json" }),
      });
      const sample = await r.text().catch(() => "");
      if (r.status === 404) {
        olog("cml delete -> 404 (treat as success)", { attempt: a.label });
        return true;
      }
      if (r.ok) {
        olog("cml delete -> success", { attempt: a.label });
        return true;
      }
      olog("cml delete -> failed", { attempt: a.label, status: r.status, sample: sample.slice(0, 400) });
    } catch (e) {
      olog("cml delete -> error", { attempt: a.label, err: String(e) });
    }
  }
  return false;
}
