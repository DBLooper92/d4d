// src/lib/ghlTokens.ts
// Robust token helper for LeadConnector (GHL) that:
//  - prefers a valid saved *location* access token
//  - refreshes when expiring
//  - on refresh invalid_grant, falls back to agency->location token exchange
//  - persists updated tokens

import { Timestamp } from "firebase-admin/firestore";
import { db } from "@/lib/firebaseAdmin"; // 👈 your repo exports a function `db()`

// ====== CONFIG ======
const OAUTH_BASE =
  process.env.GHL_OAUTH_BASE || "https://services.leadconnectorhq.com/oauth";
const API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";

const GHL_CLIENT_ID =
  process.env.FIREBASE_GHL_CLIENT_ID || process.env.GHL_CLIENT_ID;
const GHL_CLIENT_SECRET =
  process.env.FIREBASE_GHL_CLIENT_SECRET || process.env.GHL_CLIENT_SECRET;

// Firestore storage locations (tweak if your repo uses different paths)
const TOKENS_COLLECTION = "ghlTokens";
const TOKENS_AGENCY_DOC_ID = "agency";
const TOKENS_LOCATIONS_COLLECTION = "locations";

type OAuthTokenResponse = {
  access_token: string;
  token_type: "Bearer" | string;
  expires_in: number; // seconds
  refresh_token?: string;
  scope?: string;
};

type StoredToken = {
  accessToken: string;
  refreshToken?: string | null;
  // Unix ms timestamp when the access token expires
  expiresAt: number;
  // For debug/ops
  updatedAt?: FirebaseFirestore.Timestamp;
};

// Small clock skew to preempt expiry
const SKEW_MS = 2 * 60 * 1000; // 2 minutes

function nowMs() {
  return Date.now();
}

function isFresh(expiresAt: number | undefined | null) {
  if (!expiresAt) return false;
  return expiresAt - SKEW_MS > nowMs();
}

// ===== Firestore helpers (use db() everywhere) =====
async function readAgencyToken(): Promise<StoredToken | null> {
  const snap = await db().collection(TOKENS_COLLECTION).doc(TOKENS_AGENCY_DOC_ID).get();
  if (!snap.exists) return null;
  const data = snap.data() as StoredToken;
  return data || null;
}

async function writeAgencyToken(tok: StoredToken): Promise<void> {
  await db()
    .collection(TOKENS_COLLECTION)
    .doc(TOKENS_AGENCY_DOC_ID)
    .set({ ...tok, updatedAt: Timestamp.now() }, { merge: true });
}

async function readLocationToken(locationId: string): Promise<StoredToken | null> {
  const snap = await db()
    .collection(TOKENS_COLLECTION)
    .doc(TOKENS_AGENCY_DOC_ID)
    .collection(TOKENS_LOCATIONS_COLLECTION)
    .doc(locationId)
    .get();
  if (!snap.exists) return null;
  const data = snap.data() as StoredToken;
  return data || null;
}

async function writeLocationToken(locationId: string, tok: StoredToken): Promise<void> {
  await db()
    .collection(TOKENS_COLLECTION)
    .doc(TOKENS_AGENCY_DOC_ID)
    .collection(TOKENS_LOCATIONS_COLLECTION)
    .doc(locationId)
    .set({ ...tok, updatedAt: Timestamp.now() }, { merge: true });
}

// ===== OAuth calls =====
async function doTokenRefresh(refreshToken: string): Promise<OAuthTokenResponse> {
  if (!GHL_CLIENT_ID || !GHL_CLIENT_SECRET) {
    throw new Error("Missing GHL client credentials");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: GHL_CLIENT_ID,
    client_secret: GHL_CLIENT_SECRET,
    refresh_token: refreshToken,
  });

  const res = await fetch(`${OAUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Version: API_VERSION,
    },
    body,
    cache: "no-store",
  });

  const payload = await res.json().catch(async () => ({ text: await res.text() }));
  if (!res.ok) {
    const message = `refresh exchange failed: ${res.status} ${JSON.stringify(payload)}`;
    throw new Error(message);
  }
  return payload as OAuthTokenResponse;
}

async function getLocationTokenViaAgency(
  agencyAccessToken: string,
  locationId: string
): Promise<OAuthTokenResponse> {
  // LeadConnector "Get Location Access Token from Agency Token"
  const url = `${OAUTH_BASE}/locationToken?${new URLSearchParams({ locationId }).toString()}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${agencyAccessToken}`,
      Accept: "application/json",
      Version: API_VERSION,
    },
    cache: "no-store",
  });

  const payload = await res.json().catch(async () => ({ text: await res.text() }));
  if (!res.ok) {
    const message = `agency->location exchange failed: ${res.status} ${JSON.stringify(payload)}`;
    throw new Error(message);
  }
  return payload as OAuthTokenResponse;
}

// If your agency token itself can refresh, this will refresh/persist it.
// If it's long-lived, this just returns the saved access token.
async function getValidAgencyAccessToken(): Promise<string> {
  const agencyTok = await readAgencyToken();
  if (!agencyTok) {
    throw new Error("No stored agency token. Reconnect agency OAuth.");
  }
  if (isFresh(agencyTok.expiresAt)) return agencyTok.accessToken;

  if (!agencyTok.refreshToken) {
    throw new Error("Agency token expired and no refresh_token available. Reconnect agency OAuth.");
  }

  const refreshed = await doTokenRefresh(agencyTok.refreshToken);
  const expiresAt = nowMs() + (refreshed.expires_in ?? 0) * 1000;
  const stored: StoredToken = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? agencyTok.refreshToken ?? null,
    expiresAt,
  };
  await writeAgencyToken(stored);
  return stored.accessToken;
}

// ===== Public: getValidAccessTokenForLocation =====
export async function getValidAccessTokenForLocation(locationId: string): Promise<string> {
  // 1) Use valid saved location access token if still fresh
  const saved = await readLocationToken(locationId);
  if (saved && isFresh(saved.expiresAt)) {
    return saved.accessToken;
  }

  // 2) If we have a refresh token for the location, try to refresh
  if (saved?.refreshToken) {
    try {
      const refreshed = await doTokenRefresh(saved.refreshToken);
      const expiresAt = nowMs() + (refreshed.expires_in ?? 0) * 1000;
      const stored: StoredToken = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? saved.refreshToken ?? null,
        expiresAt,
      };
      await writeLocationToken(locationId, stored);
      return stored.accessToken;
    } catch (err) {
      const msg = (err as Error)?.message || "";
      // If the refresh token was invalid/revoked, fall through to agency->location exchange
      if (!/invalid_grant/i.test(msg)) {
        throw err;
      }
      // else continue to step 3
    }
  }

  // 3) Fallback: agency -> location token exchange (no location refresh token needed)
  const agencyAccess = await getValidAgencyAccessToken();
  const exchanged = await getLocationTokenViaAgency(agencyAccess, locationId);
  const expiresAt = nowMs() + (exchanged.expires_in ?? 0) * 1000;

  // /oauth/locationToken usually returns just an access token (refresh not guaranteed)
  const stored: StoredToken = {
    accessToken: exchanged.access_token,
    refreshToken: exchanged.refresh_token ?? null,
    expiresAt,
  };
  await writeLocationToken(locationId, stored);
  return stored.accessToken;
}

// Convenience: thin wrapper to call LeadConnector with Version header.
export async function ghlFetch(
  input: string | URL,
  init: RequestInit & { token: string }
): Promise<Response> {
  const { token, headers, ...rest } = init;
  return fetch(input, {
    ...rest,
    headers: {
      ...(headers || {}),
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Version: API_VERSION,
    },
    cache: "no-store",
  });
}
