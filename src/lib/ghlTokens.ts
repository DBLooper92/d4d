// src/lib/ghlTokens.ts
import 'server-only';
import { db } from '@/lib/firebaseAdmin';

const firestore = db();

const API_BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

type StoredToken = {
  userType: 'Company' | 'Location';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // unix seconds
  companyId?: string;
  lastLocationTokens?: Record<
    string,
    {
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
    }
  >;
};

type OAuthTokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  userType?: 'Company' | 'Location';
  companyId?: string;
  locationId?: string;
  userId?: string;
};

const TOKENS_COLL = 'ghlTokens';

const epochSec = () => Math.floor(Date.now() / 1000);

function envRequired(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const CLIENT_ID = envRequired('GHL_CLIENT_ID');
const CLIENT_SECRET = envRequired('GHL_CLIENT_SECRET');
const REDIRECT_URI = envRequired('GHL_REDIRECT_URI');

function tokenDocRef(locationId: string) {
  // Use the Firestore instance, not the db() function itself
  return firestore.collection(TOKENS_COLL).doc(locationId);
}

async function readStoredToken(locationId: string): Promise<StoredToken | null> {
  const snap = await tokenDocRef(locationId).get();
  return snap.exists ? (snap.data() as StoredToken) : null;
}

async function writeStoredToken(locationId: string, data: Partial<StoredToken>) {
  await tokenDocRef(locationId).set(data, { merge: true });
}

async function postForm<T>(url: string, form: Record<string, string>): Promise<T> {
  const body = new URLSearchParams(form);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`POST ${url} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, json: unknown, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(json),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`POST ${url} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Internal refresh — used by both Company & Location tokens (env client creds) */
async function refreshAccessToken(refreshToken: string, userType: 'Company' | 'Location') {
  return postForm<OAuthTokenResponse>(`${API_BASE}/oauth/token`, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    user_type: userType,
    redirect_uri: REDIRECT_URI,
  });
}

/** Mint a Location token from an Agency token */
async function getLocationAccessTokenFromAgency(
  companyId: string,
  locationId: string,
  agencyAccessToken: string
) {
  return postJson<OAuthTokenResponse>(
    `${API_BASE}/oauth/locationToken`,
    { companyId, locationId },
    { Authorization: `Bearer ${agencyAccessToken}`, Version: VERSION }
  );
}

/**
 * Returns a valid Location access token for the given location.
 * Handles cached minted tokens, direct Location tokens (refresh), or mint from Agency token.
 */
export async function getValidLocationAccessToken(locationId: string, companyId?: string): Promise<string> {
  const stored = await readStoredToken(locationId);
  const now = epochSec();

  // Prefer a cached minted Location token for this location
  const cached = stored?.lastLocationTokens?.[locationId];
  if (cached) {
    const nearlyExpired = cached.expiresAt ? cached.expiresAt - 60 <= now : false;
    if (nearlyExpired && cached.refreshToken) {
      try {
        const refreshed = await refreshAccessToken(cached.refreshToken, 'Location');
        const expiresAt = now + (refreshed.expires_in ?? 0);
        await writeStoredToken(locationId, {
          lastLocationTokens: {
            ...(stored?.lastLocationTokens ?? {}),
            [locationId]: {
              accessToken: refreshed.access_token,
              refreshToken: refreshed.refresh_token,
              expiresAt,
            },
          },
        });
        return refreshed.access_token;
      } catch {
        // fall through to mint from agency or use base token
      }
    }
    if (!nearlyExpired) return cached.accessToken;
  }

  // If the stored top-level token is a Location token, refresh/use it
  if (stored?.userType === 'Location') {
    const nearlyExpired = stored.expiresAt ? stored.expiresAt - 60 <= now : false;
    if (nearlyExpired && stored.refreshToken) {
      const refreshed = await refreshAccessToken(stored.refreshToken, 'Location');
      const expiresAt = now + (refreshed.expires_in ?? 0);
      await writeStoredToken(locationId, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt,
      });
      return refreshed.access_token;
    }
    if (stored.accessToken && !nearlyExpired) return stored.accessToken;
  }

  // If we have an Agency token, mint a Location token for this location
  if (stored?.userType === 'Company' && stored.accessToken) {
    const compId = stored.companyId ?? companyId;
    if (!compId) throw new Error('Missing companyId to mint a Location token.');
    const minted = await getLocationAccessTokenFromAgency(compId, locationId, stored.accessToken);
    const expiresAt = now + (minted.expires_in ?? 0);
    await writeStoredToken(locationId, {
      lastLocationTokens: {
        ...(stored.lastLocationTokens ?? {}),
        [locationId]: {
          accessToken: minted.access_token,
          refreshToken: minted.refresh_token,
          expiresAt,
        },
      },
    });
    return minted.access_token;
  }

  throw new Error('No valid token for this location. Reconnect OAuth or reinstall.');
}

export async function saveInitialTokenForLocation(locationId: string, payload: OAuthTokenResponse) {
  const expiresAt = epochSec() + (payload.expires_in ?? 0);
  const base: Partial<StoredToken> = {
    userType: (payload.userType ?? 'Location') as StoredToken['userType'],
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt,
  };
  if (payload.companyId) base.companyId = payload.companyId;
  await writeStoredToken(locationId, base);
}

/**
 * GET helper that injects Version/Authorization and retries once on 401.
 */
export async function ghlLocationGetJson<T>(locationId: string, url: string, companyId?: string): Promise<T> {
  let token = await getValidLocationAccessToken(locationId, companyId);

  const doFetch = async (bearer: string) =>
    fetch(url, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        Version: VERSION,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    token = await getValidLocationAccessToken(locationId, companyId);
    res = await doFetch(token);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return (await res.json()) as T;
}

/* -------------------------------------------------------------------------- */
/* Backward-compat exports (to satisfy existing imports in your codebase)     */
/* -------------------------------------------------------------------------- */

/** Overloads so existing callers keep working */
export async function exchangeRefreshToken(
  refreshToken: string,
  userType: 'Company' | 'Location'
): Promise<OAuthTokenResponse>;
export async function exchangeRefreshToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<OAuthTokenResponse>;
export async function exchangeRefreshToken(
  refreshToken: string,
  a: 'Company' | 'Location' | string,
  b?: string
): Promise<OAuthTokenResponse> {
  // Shape A: (refreshToken, clientId, clientSecret) — legacy callers
  if (typeof a === 'string' && typeof b === 'string') {
    const clientId = a;
    const clientSecret = b;
    // Default to Location when legacy callers don't pass userType
    return postForm<OAuthTokenResponse>(`${API_BASE}/oauth/token`, {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      user_type: 'Location',
      redirect_uri: REDIRECT_URI,
    });
  }

  // Shape B: (refreshToken, userType) — use env client credentials
  const userType = (a as 'Company' | 'Location') ?? 'Location';
  return postForm<OAuthTokenResponse>(`${API_BASE}/oauth/token`, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    user_type: userType,
    redirect_uri: REDIRECT_URI,
  });
}

/** Legacy alias retained for callers elsewhere */
export async function getValidAccessTokenForLocation(locationId: string, companyId?: string) {
  return getValidLocationAccessToken(locationId, companyId);
}
