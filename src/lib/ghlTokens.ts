// src/lib/ghlTokens.ts
import { db } from "@/lib/firebaseAdmin";

/**
 * ===== FIELD MAPPINGS (adjust to your current schema if needed) =====
 * We try these locations, in order, to find the token payload for a location:
 *   A) locations/{locationId} -> oauth.accessToken / oauth.refreshToken / oauth.expiresAt
 *   B) locations/{locationId} -> ghl.accessToken   / ghl.refreshToken   / ghl.expiresAt
 *   C) oauth_tokens/{locationId} -> accessToken / refreshToken / expiresAt
 */

type AnyObj = Record<string, unknown>;

function readAtPath(o: AnyObj | undefined, path: string): unknown {
  if (!o) return undefined;
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object" && k in (acc as AnyObj)) return (acc as AnyObj)[k];
    return undefined;
  }, o);
}

function coerceMs(v: unknown): number | null {
  if (!v) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n) && n > 0) return n;
    const d = Date.parse(v);
    if (!Number.isNaN(d)) return d;
  }
  return null;
}

export type StoredToken = {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAtMs: number | null;
  _docRefPath: string | null;
  _writeAccessPath: string | null;
  _writeExpiresPath: string | null;
};

async function readTokenForLocation(locationId: string): Promise<StoredToken> {
  // Try locations/{id}
  const locRef = db().collection("locations").doc(locationId);
  const locSnap = await locRef.get();
  if (locSnap.exists) {
    const data = (locSnap.data() || {}) as AnyObj;

    // Option A: oauth.*
    {
      const access = readAtPath(data, "oauth.accessToken");
      const refresh = readAtPath(data, "oauth.refreshToken");
      const expires = readAtPath(data, "oauth.expiresAt");
      if (typeof access === "string" || typeof refresh === "string") {
        return {
          accessToken: (access as string) || null,
          refreshToken: (refresh as string) || null,
          expiresAtMs: coerceMs(expires),
          _docRefPath: locRef.path,
          _writeAccessPath: "oauth.accessToken",
          _writeExpiresPath: "oauth.expiresAt",
        };
      }
    }

    // Option B: ghl.*
    {
      const access = readAtPath(data, "ghl.accessToken");
      const refresh = readAtPath(data, "ghl.refreshToken");
      const expires = readAtPath(data, "ghl.expiresAt");
      if (typeof access === "string" || typeof refresh === "string") {
        return {
          accessToken: (access as string) || null,
          refreshToken: (refresh as string) || null,
          expiresAtMs: coerceMs(expires),
          _docRefPath: locRef.path,
          _writeAccessPath: "ghl.accessToken",
          _writeExpiresPath: "ghl.expiresAt",
        };
      }
    }
  }

  // Option C: oauth_tokens/{locationId}
  const tokRef = db().collection("oauth_tokens").doc(locationId);
  const tokSnap = await tokRef.get();
  if (tokSnap.exists) {
    const d = (tokSnap.data() || {}) as AnyObj;
    const access = d.accessToken as string | undefined;
    const refresh = d.refreshToken as string | undefined;
    const expires = d.expiresAt;
    return {
      accessToken: access || null,
      refreshToken: refresh || null,
      expiresAtMs: coerceMs(expires),
      _docRefPath: tokRef.path,
      _writeAccessPath: "accessToken",
      _writeExpiresPath: "expiresAt",
    };
  }

  return {
    accessToken: null,
    refreshToken: null,
    expiresAtMs: null,
    _docRefPath: null,
    _writeAccessPath: null,
    _writeExpiresPath: null,
  };
}

async function _refreshAccessToken(
  refreshToken: string,
  clientId?: string,
  clientSecret?: string
): Promise<{ access_token: string; expires_in: number }> {
  const cid = clientId || process.env.GHL_CLIENT_ID;
  const csec = clientSecret || process.env.GHL_CLIENT_SECRET;
  if (!cid || !csec) {
    throw new Error("GHL_CLIENT_ID / GHL_CLIENT_SECRET are not configured.");
  }

  const body = new URLSearchParams({
    client_id: cid,
    client_secret: csec,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch("https://services.leadconnectorhq.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GHL token refresh failed ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as { access_token: string; expires_in: number };
}

/** PUBLIC: legacy compat — supports 1 or 3 args */
export function exchangeRefreshToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }>;
export function exchangeRefreshToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<{ access_token: string; expires_in: number }>;
export function exchangeRefreshToken(
  refreshToken: string,
  clientId?: string,
  clientSecret?: string
): Promise<{ access_token: string; expires_in: number }> {
  return _refreshAccessToken(refreshToken, clientId, clientSecret);
}

/** PUBLIC: obtain a valid access token for a given locationId (auto-refresh + persist) */
export async function getValidAccessTokenForLocation(locationId: string): Promise<string> {
  const t = await readTokenForLocation(locationId);
  const now = Date.now();
  const skewMs = 60 * 1000; // refresh 1min early

  if (t.accessToken && t.expiresAtMs && t.expiresAtMs > now + skewMs) {
    return t.accessToken;
  }

  if (!t.refreshToken) {
    throw new Error("No refresh token available for this location.");
  }

  // Refresh using env client creds (or whatever _refreshAccessToken resolves from env)
  const refreshed = await _refreshAccessToken(t.refreshToken);

  // Compute new expiry (LeadConnector returns seconds)
  const newExpires = now + refreshed.expires_in * 1000;

  // Write back to the same doc/paths we read
  if (t._docRefPath && t._writeAccessPath && t._writeExpiresPath) {
    const parts = t._docRefPath.split("/");
    const collection = parts.slice(0, -1).join("/");
    const docId = parts.at(-1)!;

    const update: Record<string, unknown> = {};
    update[t._writeAccessPath] = refreshed.access_token;
    update[t._writeExpiresPath] = newExpires;

    await db().collection(collection).doc(docId).set(update, { merge: true });
  }

  return refreshed.access_token;
}
