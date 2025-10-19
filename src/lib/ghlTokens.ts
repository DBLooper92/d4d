// src/lib/ghlTokens.ts

import { db } from "@/lib/firebaseAdmin";
import { ghlTokenUrl } from "./ghl";

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

export type RefreshExchangeResponse = {
  access_token: string;
  scope?: string;          // <-- your existing routes read this
  token_type?: string;
  expires_in: number;      // seconds
};

export type StoredToken = {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAtMs: number | null;
  _docRefPath: string | null;
  _writeAccessPath: string | null;
  _writeExpiresPath: string | null;
};

async function readTokenForLocation(locationId: string): Promise<StoredToken> {
  // A) locations/{id} oauth.*
  const locRef = db().collection("locations").doc(locationId);
  const locSnap = await locRef.get();
  if (locSnap.exists) {
    const data = (locSnap.data() || {}) as AnyObj;

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

    // B) locations/{id} ghl.*
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

    // Top-level fields fallback (locations/{id}.refreshToken, etc.)
    {
      const access = typeof data.accessToken === "string" ? data.accessToken : null;
      const refresh = typeof data.refreshToken === "string" ? data.refreshToken : null;
      const expires = data.expiresAt;
      if (access || refresh) {
        return {
          accessToken: access,
          refreshToken: refresh,
          expiresAtMs: coerceMs(expires),
          _docRefPath: locRef.path,
          _writeAccessPath: "accessToken",
          _writeExpiresPath: "expiresAt",
        };
      }
    }
  }

  // C) oauth_tokens/{locationId}
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

async function _doRefresh(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<RefreshExchangeResponse> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const r = await fetch(ghlTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form,
    cache: "no-store",
  });

  const raw = await r.text();
  if (!r.ok) {
    throw new Error(`refresh exchange failed: ${r.status} ${raw.slice(0, 400)}`);
  }

  try {
    return JSON.parse(raw) as RefreshExchangeResponse;
  } catch {
    throw new Error(`refresh exchange bad JSON: ${raw.slice(0, 400)}`);
  }
}

/**
 * PUBLIC: Legacy/compat function used across the codebase.
 * Supports BOTH signatures:
 *   1) exchangeRefreshToken(refreshToken, clientId, clientSecret)  // your original
 *   2) exchangeRefreshToken(refreshToken)                          // env-based fallback
 */
export function exchangeRefreshToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<RefreshExchangeResponse>;
export function exchangeRefreshToken(refreshToken: string): Promise<RefreshExchangeResponse>;
export function exchangeRefreshToken(
  refreshToken: string,
  clientId?: string,
  clientSecret?: string
): Promise<RefreshExchangeResponse> {
  const cid = clientId ?? process.env.GHL_CLIENT_ID;
  const csec = clientSecret ?? process.env.GHL_CLIENT_SECRET;
  if (!cid || !csec) {
    throw new Error("GHL_CLIENT_ID / GHL_CLIENT_SECRET are not configured.");
  }
  return _doRefresh(refreshToken, cid, csec);
}

/**
 * PUBLIC: Obtain a valid access token for a given location (auto-refresh + persist).
 * Uses the flexible mapping documented at the top of this file.
 */
export async function getValidAccessTokenForLocation(locationId: string): Promise<string> {
  const t = await readTokenForLocation(locationId);
  const now = Date.now();
  const skewMs = 60 * 1000; // refresh 1 minute early

  if (t.accessToken && t.expiresAtMs && t.expiresAtMs > now + skewMs) {
    return t.accessToken;
  }

  if (!t.refreshToken) {
    throw new Error("No refresh token available for this location.");
  }

  const tok = await exchangeRefreshToken(t.refreshToken); // uses env creds if not passed
  const newExpiresMs = now + tok.expires_in * 1000;

  // Write back to the same doc/paths we read
  if (t._docRefPath && t._writeAccessPath && t._writeExpiresPath) {
    const parts = t._docRefPath.split("/");
    const collection = parts.slice(0, -1).join("/");
    const docId = parts.at(-1)!;

    const update: Record<string, unknown> = {};
    update[t._writeAccessPath] = tok.access_token;
    update[t._writeExpiresPath] = newExpiresMs;

    await db().collection(collection).doc(docId).set(update, { merge: true });
  }

  return tok.access_token;
}
