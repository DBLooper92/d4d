// src/lib/ghlTokens.ts
//
// Centralized helpers for LeadConnector token storage & refresh.
// Now persists rotated refresh tokens returned by the OAuth refresh flow
// and provides `getFreshAccessTokenForLocation(...)` for "always-refresh" use-cases.

import { db } from "@/lib/firebaseAdmin";
import { ghlTokenUrl } from "./ghl";

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
  refresh_token?: string; // LeadConnector may rotate this; persist if present
  scope?: string;
  token_type?: string;
  expires_in: number; // seconds
};

export type StoredToken = {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAtMs: number | null;
  _docRefPath: string | null;
  _writeAccessPath: string | null;
  _writeRefreshPath: string | null;
  _writeExpiresPath: string | null;
};

async function readTokenForLocation(locationId: string): Promise<StoredToken> {
  // A) locations/{id} oauth.*
  const locRef = db().collection("locations").doc(locationId);
  const locSnap = await locRef.get();
  if (locSnap.exists) {
    const data = (locSnap.data() || {}) as AnyObj;

    // A) locations/{id}.oauth.*
    {
      const accessU = readAtPath(data, "oauth.accessToken");
      const refreshU = readAtPath(data, "oauth.refreshToken");
      const expiresU = readAtPath(data, "oauth.expiresAt");

      if (typeof accessU === "string" || typeof refreshU === "string") {
        const accessStr: string | null = typeof accessU === "string" ? accessU : null;
        const refreshStr: string | null = typeof refreshU === "string" ? refreshU : null;
        const result: StoredToken = {
          accessToken: accessStr,
          refreshToken: refreshStr,
          expiresAtMs: coerceMs(expiresU),
          _docRefPath: locRef.path,
          _writeAccessPath: "oauth.accessToken",
          _writeRefreshPath: "oauth.refreshToken",
          _writeExpiresPath: "oauth.expiresAt",
        };
        return result;
      }
    }

    // B) locations/{id}.ghl.*
    {
      const accessU = readAtPath(data, "ghl.accessToken");
      const refreshU = readAtPath(data, "ghl.refreshToken");
      const expiresU = readAtPath(data, "ghl.expiresAt");

      if (typeof accessU === "string" || typeof refreshU === "string") {
        const accessStr: string | null = typeof accessU === "string" ? accessU : null;
        const refreshStr: string | null = typeof refreshU === "string" ? refreshU : null;
        const result: StoredToken = {
          accessToken: accessStr,
          refreshToken: refreshStr,
          expiresAtMs: coerceMs(expiresU),
          _docRefPath: locRef.path,
          _writeAccessPath: "ghl.accessToken",
          _writeRefreshPath: "ghl.refreshToken",
          _writeExpiresPath: "ghl.expiresAt",
        };
        return result;
      }
    }

    // C) Top-level fallback (locations/{id}.accessToken/refreshToken/expiresAt)
    {
      const accessTop = (data as AnyObj).accessToken;
      const refreshTop = (data as AnyObj).refreshToken;
      const expiresTop = (data as AnyObj).expiresAt;

      const accessStr: string | null = typeof accessTop === "string" ? accessTop : null;
      const refreshStr: string | null = typeof refreshTop === "string" ? refreshTop : null;

      if (accessStr || refreshStr) {
        const result: StoredToken = {
          accessToken: accessStr,
          refreshToken: refreshStr,
          expiresAtMs: coerceMs(expiresTop),
          _docRefPath: locRef.path,
          _writeAccessPath: "accessToken",
          _writeRefreshPath: "refreshToken",
          _writeExpiresPath: "expiresAt",
        };
        return result;
      }
    }
  }

  // D) oauth_tokens/{locationId}
  {
    type TokDoc = { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
    const tokRef = db().collection("oauth_tokens").doc(locationId);
    const tokSnap = await tokRef.get();
    if (tokSnap.exists) {
      const d = (tokSnap.data() || {}) as TokDoc;

      const accessU = d.accessToken;
      const refreshU = d.refreshToken;
      const expiresU = d.expiresAt;

      const accessStr: string | null = typeof accessU === "string" ? accessU : null;
      const refreshStr: string | null = typeof refreshU === "string" ? refreshU : null;

      const result: StoredToken = {
        accessToken: accessStr,
        refreshToken: refreshStr,
        expiresAtMs: coerceMs(expiresU),
        _docRefPath: tokRef.path,
        _writeAccessPath: "accessToken",
        _writeRefreshPath: "refreshToken",
        _writeExpiresPath: "expiresAt",
      };
      return result;
    }
  }

  const empty: StoredToken = {
    accessToken: null,
    refreshToken: null,
    expiresAtMs: null,
    _docRefPath: null,
    _writeAccessPath: null,
    _writeRefreshPath: null,
    _writeExpiresPath: null,
  };
  return empty;
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
 * PUBLIC: Legacy/compat function.
 * Two signatures:
 *   1) exchangeRefreshToken(refreshToken, clientId, clientSecret)
 *   2) exchangeRefreshToken(refreshToken)  // env fallback
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
 * Obtain a valid access token for a location (refresh just-in-time).
 * If the refresh response contains a rotated refresh_token, persist it.
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

  const tok = await exchangeRefreshToken(t.refreshToken);
  const newExpiresMs = now + tok.expires_in * 1000;

  // Persist tokens (access + optional rotated refresh)
  if (t._docRefPath && t._writeAccessPath && t._writeExpiresPath) {
    const parts = t._docRefPath.split("/");
    const collection = parts.slice(0, -1).join("/");
    const docId = parts.at(-1)!;

    const update: Record<string, unknown> = {};
    update[t._writeAccessPath] = tok.access_token;
    update[t._writeExpiresPath] = newExpiresMs;
    if (tok.refresh_token && t._writeRefreshPath) {
      update[t._writeRefreshPath] = tok.refresh_token;
    }

    await db().collection(collection).doc(docId).set(update, { merge: true });
  }

  return tok.access_token;
}

/**
 * ALWAYS refresh (ignore any cached access token). Useful for sensitive endpoints
 * where we want to guarantee a fresh access token each time we’re hit.
 * Also persists a rotated refresh_token if the provider returns one.
 */
export async function getFreshAccessTokenForLocation(locationId: string): Promise<string> {
  const t = await readTokenForLocation(locationId);
  if (!t.refreshToken) {
    throw new Error("No refresh token available for this location.");
  }

  const tok = await exchangeRefreshToken(t.refreshToken);
  const newExpiresMs = Date.now() + tok.expires_in * 1000;

  if (t._docRefPath && t._writeAccessPath && t._writeExpiresPath) {
    const parts = t._docRefPath.split("/");
    const collection = parts.slice(0, -1).join("/");
    const docId = parts.at(-1)!;

    const update: Record<string, unknown> = {};
    update[t._writeAccessPath] = tok.access_token;
    update[t._writeExpiresPath] = newExpiresMs;
    if (tok.refresh_token && t._writeRefreshPath) {
      update[t._writeRefreshPath] = tok.refresh_token; // persist rotated refresh token
    }

    await db().collection(collection).doc(docId).set(update, { merge: true });
  }

  return tok.access_token;
}
