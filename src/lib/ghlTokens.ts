// src/lib/ghlTokens.ts
import { db } from "@/lib/firebaseAdmin";

/**
 * ===== FIELD MAPPINGS (adjust to your current schema if needed) =====
 *
 * We try these locations, in order, to find the token payload for a location:
 *
 *   A) locations/{locationId}
 *      - oauth.accessToken
 *      - oauth.refreshToken
 *      - oauth.expiresAt (ms epoch or ISO)
 *
 *   B) locations/{locationId}
 *      - ghl.accessToken
 *      - ghl.refreshToken
 *      - ghl.expiresAt
 *
 *   C) oauth_tokens/{locationId}
 *      - accessToken
 *      - refreshToken
 *      - expiresAt
 *
 * If access token is missing/expired, we refresh with refresh_token and update the same doc.
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
  expiresAtMs: number | null; // epoch ms when access token expires
  // docRefPath: where we should write back on refresh
  _docRefPath: string | null;
  // field paths to update on refresh
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
    let access = readAtPath(data, "oauth.accessToken");
    let refresh = readAtPath(data, "oauth.refreshToken");
    let expires = readAtPath(data, "oauth.expiresAt");
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

    // Option B: ghl.*
    access = readAtPath(data, "ghl.accessToken");
    refresh = readAtPath(data, "ghl.refreshToken");
    expires = readAtPath(data, "ghl.expiresAt");
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

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const clientId = process.env.GHL_CLIENT_ID;
  const clientSecret = process.env.GHL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GHL_CLIENT_ID / GHL_CLIENT_SECRET are not configured.");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
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

  // Refresh
  const refreshed = await refreshAccessToken(t.refreshToken);

  // Compute new expiry (LeadConnector returns seconds)
  const newExpires = now + refreshed.expires_in * 1000;

  // Write back to the same doc/paths we read
  if (t._docRefPath && t._writeAccessPath && t._writeExpiresPath) {
    const [collection, docId] = t._docRefPath.split("/").slice(-2);
    // Support nested paths via FieldPath shorthand
    const update: Record<string, unknown> = {};
    update[t._writeAccessPath] = refreshed.access_token;
    update[t._writeExpiresPath] = newExpires;

    await db().collection(collection).doc(docId).set(update, { merge: true });
  }

  return refreshed.access_token;
}
