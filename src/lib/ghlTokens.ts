// src/lib/ghlTokens.ts

import { db } from "@/lib/firebaseAdmin";
import { getGhlConfig, ghlTokenUrl } from "./ghl";

/**
 * ===== FIELD MAPPINGS (adjust to your current schema if needed) =====
 * We try these locations, in order, to find the token payload for a location:
 *   A) locations/{locationId} -> oauth.accessToken / oauth.refreshToken / oauth.expiresAt
 *   B) locations/{locationId} -> ghl.accessToken   / ghl.refreshToken   / ghl.expiresAt
 *   C) locations/{locationId} -> accessToken       / refreshToken       / expiresAt   (TOP-LEVEL)
 *   D) oauth_tokens/{locationId} -> accessToken / refreshToken / expiresAt
 */

type AnyObj = Record<string, unknown>;

function readAtPath(o: AnyObj | undefined, path: string): unknown {
  if (!o) return undefined;
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object" && k in (acc as AnyObj)) return (acc as AnyObj)[k];
    return undefined;
  }, o);
}

function joinField(base: string | null, field: string): string {
  return base ? `${base}.${field}` : field;
}

function asTokenString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeExpiryMs(value: unknown): number | null {
  if (value == null) return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    const n = value;
    if (n <= 0) return null;
    // If it's clearly seconds (10-11 digits), convert to ms.
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof value === "object") {
    const ts = value as { toMillis?: () => number; seconds?: number; nanoseconds?: number };
    if (typeof ts.toMillis === "function") {
      const ms = ts.toMillis();
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof ts.seconds === "number") {
      const baseMs = ts.seconds * 1000;
      const extra = typeof ts.nanoseconds === "number" ? ts.nanoseconds / 1e6 : 0;
      const total = baseMs + extra;
      return Number.isFinite(total) ? Math.round(total) : null;
    }
  }

  return null;
}

export type RefreshExchangeResponse = {
  access_token: string;
  refresh_token?: string;
  scope?: string;          // many routes read/forward this
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
  _writeRefreshPath: string | null;
};

const TOKEN_BASE_PATHS: (string | null)[] = ["oauth", "ghl", null]; // include top-level
const AGENCY_ID_PATHS = [
  "agencyId",
  "agency.id",
  "agency.agencyId",
  "agency.agency_id",
  "companyId",
  "company.id",
  "company.companyId",
  "company.company_id",
  "agency_id",
];

const EXPIRE_CANDIDATES = {
  camel: ["expiresAt", "expiryAt", "expiry", "expires", "expiresAtMs", "expiryMs"],
  snake: ["expires_at", "expiry_at", "expiry", "expires", "expires_at_ms", "expires_in", "expires_in_ms"],
};

type Style = "camel" | "snake";
const STYLE_CANDIDATES: Record<Style, { access: string[]; refresh: string[] }> = {
  camel: { access: ["accessToken"], refresh: ["refreshToken"] },
  snake: { access: ["access_token"], refresh: ["refresh_token"] },
};

function pickField(data: AnyObj, base: string | null, candidates: string[]) {
  for (const field of candidates) {
    const path = joinField(base, field);
    const raw = readAtPath(data, path);
    if (raw !== undefined && raw !== null) {
      return { raw, path };
    }
  }
  return { raw: undefined, path: null };
}

function ensureWritePath(base: string | null, candidates: string[], preferred: string | null): string {
  if (preferred) return preferred;
  const first = candidates[0];
  return joinField(base, first);
}

function extractStoredToken(data: AnyObj, docRefPath: string, basePaths = TOKEN_BASE_PATHS): StoredToken | null {
  for (const base of basePaths) {
    for (const style of ["camel", "snake"] as const) {
      const accessCandidates = STYLE_CANDIDATES[style].access;
      const refreshCandidates = STYLE_CANDIDATES[style].refresh;
      const expireCandidates = EXPIRE_CANDIDATES[style];

      const accessInfo = pickField(data, base, accessCandidates);
      const refreshInfo = pickField(data, base, refreshCandidates);
      const expiresInfo = pickField(data, base, expireCandidates);

      const accessToken = asTokenString(accessInfo.raw);
      const refreshToken = asTokenString(refreshInfo.raw);
      if (!accessToken && !refreshToken) continue;

      const expiresAtMs = normalizeExpiryMs(expiresInfo.raw);
      const writeAccessPath = ensureWritePath(base, accessCandidates, accessInfo.path);
      const writeExpiresPath = ensureWritePath(base, expireCandidates, expiresInfo.path);
      const writeRefreshPath = refreshInfo.path ?? null;

      return {
        accessToken,
        refreshToken,
        expiresAtMs,
        _docRefPath: docRefPath,
        _writeAccessPath: writeAccessPath,
        _writeExpiresPath: writeExpiresPath,
        _writeRefreshPath: writeRefreshPath,
      };
    }
  }
  return null;
}

function findAgencyId(data: AnyObj): string | null {
  for (const path of AGENCY_ID_PATHS) {
    const raw = readAtPath(data, path);
    const str = asString(raw);
    if (str) return str;
  }
  return null;
}

async function readTokenForLocation(locationId: string): Promise<StoredToken> {
  // A/B/C) locations/{id} (oauth.*, ghl.*, or top-level fields)
  const locRef = db().collection("locations").doc(locationId);
  const locSnap = await locRef.get();
  if (locSnap.exists) {
    const data = (locSnap.data() || {}) as AnyObj;
    const fromLocation = extractStoredToken(data, locRef.path);
    if (fromLocation) return fromLocation;

    // Also try agency mirror, if you keep a nested copy at agencies/{agencyId}/locations/{locationId}
    const agencyId = findAgencyId(data);
    if (agencyId) {
      const agLocRef = db().collection("agencies").doc(agencyId).collection("locations").doc(locationId);
      const agLocSnap = await agLocRef.get();
      if (agLocSnap.exists) {
        const agLocData = (agLocSnap.data() || {}) as AnyObj;
        const fromMirror = extractStoredToken(agLocData, agLocRef.path);
        if (fromMirror) return fromMirror;
      }
    }
  }

  // D) oauth_tokens/{locationId}
  const tokRef = db().collection("oauth_tokens").doc(locationId);
  const tokSnap = await tokRef.get();
  if (tokSnap.exists) {
    const d = (tokSnap.data() || {}) as AnyObj;
    const fromTokenDoc =
      extractStoredToken(d, tokRef.path, [null]) ||
      extractStoredToken(d, tokRef.path, TOKEN_BASE_PATHS);
    if (fromTokenDoc) return fromTokenDoc;
  }

  return {
    accessToken: null,
    refreshToken: null,
    expiresAtMs: null,
    _docRefPath: null,
    _writeAccessPath: null,
    _writeExpiresPath: null,
    _writeRefreshPath: null,
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
  if (!r.ok) throw new Error(`refresh exchange failed: ${r.status} ${raw.slice(0, 400)}`);

  try {
    return JSON.parse(raw) as RefreshExchangeResponse;
  } catch {
    throw new Error(`refresh exchange bad JSON: ${raw.slice(0, 400)}`);
  }
}

/**
 * PUBLIC: Legacy/compat function used across the codebase.
 * Supports BOTH signatures:
 *   1) exchangeRefreshToken(refreshToken, clientId, clientSecret)
 *   2) exchangeRefreshToken(refreshToken)  // env-based fallback
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

  const { clientId, clientSecret } = getGhlConfig();
  const tok = await exchangeRefreshToken(t.refreshToken, clientId, clientSecret);
  const newExpiresMs = now + tok.expires_in * 1000;

  // Write back to the same doc/paths we read
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

