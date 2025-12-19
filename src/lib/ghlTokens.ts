import { db } from "@/lib/firebaseAdmin";
import { FieldValue, Timestamp, type DocumentReference } from "firebase-admin/firestore";

const TOKEN_ENDPOINT = "https://services.leadconnectorhq.com/oauth/token";
const LOCATION_TOKEN_ENDPOINT = "https://services.leadconnectorhq.com/oauth/locationToken";
const API_VERSION = "2021-07-28";
const REFRESH_LEEWAY_MS = 5 * 60 * 1000; // refresh 5 minutes early

export class InvalidGhlRefreshTokenError extends Error {
  detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "InvalidGhlRefreshTokenError";
    this.detail = detail;
  }
}

export type RefreshExchangeResponse = {
  access_token: string;
  token_type?: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  userType?: string;
  userId?: string;
  locationId?: string;
  companyId?: string;
  approvedLocations?: string[];
  planId?: string;
};

type TokenResponse = RefreshExchangeResponse;

type LocationTokenState = {
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Timestamp | null;
  agencyId: string | null;
  companyId: string | null;
};

type AgencyTokenState = {
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Timestamp | null;
  companyId: string | null;
};

type LocationTokenResult = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  refreshed: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  return null;
}

function readTimestamp(value: unknown): Timestamp | null {
  if (!value) return null;
  if (value instanceof Timestamp) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Timestamp.fromMillis(value);
  }
  if (typeof value === "string" && value.trim().length) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return Timestamp.fromMillis(parsed);
    }
  }
  if (isRecord(value) && typeof value._seconds === "number") {
    const seconds = value._seconds;
    const nanos = typeof value._nanoseconds === "number" ? value._nanoseconds : 0;
    const millis = seconds * 1000 + Math.round(nanos / 1_000_000);
    return Timestamp.fromMillis(millis);
  }
  if (isRecord(value) && typeof (value as { toMillis?: () => number }).toMillis === "function") {
    try {
      return Timestamp.fromMillis((value as { toMillis: () => number }).toMillis());
    } catch {
      return null;
    }
  }
  return null;
}

function readNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (isRecord(acc) && key in acc) {
      return acc[key];
    }
    return undefined;
  }, obj);
}

function pickStringFromPaths(obj: Record<string, unknown>, paths: string[]): string | null {
  for (const path of paths) {
    const value = readNestedValue(obj, path);
    const str = readString(value);
    if (str) {
      return str;
    }
  }
  return null;
}

function pickTimestampFromPaths(obj: Record<string, unknown>, paths: string[]): Timestamp | null {
  for (const path of paths) {
    const value = readNestedValue(obj, path);
    const ts = readTimestamp(value);
    if (ts) {
      return ts;
    }
  }
  return null;
}

function planFields(planId?: string | null) {
  const cleaned = readString(planId);
  if (!cleaned) return {};
  return {
    ghlPlanId: cleaned,
    ghlPlanStatus: "active" as const,
    ghlPlanUpdatedAt: FieldValue.serverTimestamp(),
  };
}

async function fetchRefreshedToken(
  refreshToken: string,
  userType: "Location" | "Company",
  creds?: { clientId?: string; clientSecret?: string },
): Promise<TokenResponse> {
  const clientId = creds?.clientId ?? process.env.GHL_CLIENT_ID;
  const clientSecret = creds?.clientSecret ?? process.env.GHL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing GoHighLevel credentials (GHL_CLIENT_ID/SECRET)");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    user_type: userType,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params,
  });

  const raw = await response.text();

  if (!response.ok) {
    let detail: unknown = raw;
    try {
      detail = JSON.parse(raw) as unknown;
    } catch {
      /* keep raw text */
    }

    const code =
      detail && typeof detail === "object" && "error" in detail ? (detail as Record<string, unknown>).error : null;

    if (code === "invalid_grant") {
      throw new InvalidGhlRefreshTokenError("GoHighLevel refresh token is invalid or expired", detail);
    }

    throw new Error(`Failed to refresh GHL token (status ${response.status}): ${raw}`);
  }

  const payload = raw ? (JSON.parse(raw) as Partial<TokenResponse>) : {};

  if (!payload?.access_token || !payload?.expires_in) {
    throw new Error("GHL token refresh response missing required fields: access_token, expires_in");
  }

  return {
    access_token: payload.access_token,
    token_type: payload.token_type ?? "Bearer",
    expires_in: payload.expires_in,
    refresh_token: payload.refresh_token,
    scope: payload.scope,
    userType: payload.userType,
    userId: payload.userId,
    locationId: payload.locationId,
    companyId: payload.companyId,
    approvedLocations: payload.approvedLocations,
    planId: payload.planId,
  };
}

type LocationTokenDocState = {
  ref: DocumentReference;
  state: LocationTokenState;
  exists: boolean;
};

async function loadLocationTokenState(locationId: string): Promise<LocationTokenDocState> {
  const firestore = db();
  const ref = firestore.collection("locations").doc(locationId);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    return {
      ref,
      exists: false,
      state: {
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
        agencyId: null,
        companyId: null,
      },
    };
  }

  const data = (snapshot.data() ?? {}) as Record<string, unknown>;

  const accessToken = pickStringFromPaths(data, ["accessToken", "oauth.accessToken", "ghl.accessToken"]);
  const refreshToken = pickStringFromPaths(data, ["refreshToken", "oauth.refreshToken", "ghl.refreshToken"]);
  const accessTokenExpiresAt =
    pickTimestampFromPaths(data, ["accessTokenExpiresAt"]) ??
    pickTimestampFromPaths(data, ["expiresAt", "oauth.expiresAt", "ghl.expiresAt"]);
  const agencyId = pickStringFromPaths(data, ["agencyId", "agency.id"]);
  const companyId = pickStringFromPaths(data, ["companyId", "company.id"]);

  return {
    ref,
    exists: true,
    state: {
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      agencyId,
      companyId,
    },
  };
}

type AgencyTokenDocState = {
  ref: DocumentReference;
  state: AgencyTokenState;
  exists: boolean;
};

async function loadAgencyTokenState(agencyId: string): Promise<AgencyTokenDocState> {
  const firestore = db();
  const ref = firestore.collection("agencies").doc(agencyId);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    return {
      ref,
      exists: false,
      state: {
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
        companyId: null,
      },
    };
  }

  const data = (snapshot.data() ?? {}) as Record<string, unknown>;

  return {
    ref,
    exists: true,
    state: {
      accessToken: pickStringFromPaths(data, ["accessToken", "oauth.accessToken", "ghl.accessToken"]),
      refreshToken: pickStringFromPaths(data, ["refreshToken", "oauth.refreshToken", "ghl.refreshToken"]),
      accessTokenExpiresAt:
        pickTimestampFromPaths(data, ["accessTokenExpiresAt"]) ??
        pickTimestampFromPaths(data, ["expiresAt", "oauth.expiresAt", "ghl.expiresAt"]),
      companyId: pickStringFromPaths(data, ["companyId", "company.id"]),
    },
  };
}

async function ensureAgencyAccessToken(
  agencyId: string,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: Date | null; refreshed: boolean; companyId: string | null }> {
  const { ref, state, exists } = await loadAgencyTokenState(agencyId);

  if (!exists) {
    throw new Error(`Agency document ${agencyId} does not exist`);
  }

  if (!state.refreshToken) {
    throw new Error(`Agency ${agencyId} is missing a stored GoHighLevel refresh token`);
  }

  const expiresAtMillis = state.accessTokenExpiresAt?.toMillis() ?? null;
  const needsRefresh =
    !state.accessToken || !expiresAtMillis || expiresAtMillis <= Date.now() + REFRESH_LEEWAY_MS;

  if (!needsRefresh && state.accessToken) {
    return {
      accessToken: state.accessToken,
      refreshToken: state.refreshToken,
      expiresAt: expiresAtMillis ? new Date(expiresAtMillis) : null,
      refreshed: false,
      companyId: state.companyId,
    };
  }

  const refreshed = await fetchRefreshedToken(state.refreshToken, "Company");
  const nextExpiresAt = Timestamp.fromMillis(Date.now() + refreshed.expires_in * 1000);
  const nextRefreshToken = refreshed.refresh_token ?? state.refreshToken;
  const companyId = state.companyId ?? readString(refreshed.companyId) ?? null;

  await ref.set(
    {
      accessToken: refreshed.access_token,
      refreshToken: nextRefreshToken,
      accessTokenExpiresAt: nextExpiresAt,
      expiresAt: nextExpiresAt.toMillis(),
      ghlLastTokenRefreshAt: FieldValue.serverTimestamp(),
      ...(companyId ? { companyId } : {}),
    },
    { merge: true },
  );

  return {
    accessToken: refreshed.access_token,
    refreshToken: nextRefreshToken ?? null,
    expiresAt: new Date(nextExpiresAt.toMillis()),
    refreshed: true,
    companyId,
  };
}

type AgencyLocationTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
  locationId?: string;
  planId?: string;
  userId?: string;
};

async function fetchLocationAccessTokenFromAgency(params: {
  agencyAccessToken: string;
  companyId: string;
  locationId: string;
}): Promise<AgencyLocationTokenResponse> {
  const response = await fetch(LOCATION_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.agencyAccessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Version: API_VERSION,
    },
    body: new URLSearchParams({
      companyId: params.companyId,
      locationId: params.locationId,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to fetch location access token from agency (status ${response.status}): ${detail}`);
  }

  const payload = (await response.json()) as Partial<AgencyLocationTokenResponse>;

  if (!payload.access_token || !payload.expires_in) {
    throw new Error("Agency location token response missing required fields: access_token, expires_in");
  }

  return {
    access_token: payload.access_token,
    token_type: payload.token_type,
    expires_in: payload.expires_in,
    scope: payload.scope,
    locationId: payload.locationId,
    planId: payload.planId,
    userId: payload.userId,
  };
}

async function refreshLocationWithRefreshToken(options: {
  locationRef: DocumentReference;
  refreshToken: string;
}): Promise<LocationTokenResult> {
  const refreshed = await fetchRefreshedToken(options.refreshToken, "Location");
  const nextExpiresAt = Timestamp.fromMillis(Date.now() + refreshed.expires_in * 1000);
  const nextRefreshToken = refreshed.refresh_token ?? options.refreshToken;

  await options.locationRef.set(
    {
      accessToken: refreshed.access_token,
      refreshToken: nextRefreshToken,
      accessTokenExpiresAt: nextExpiresAt,
      expiresAt: nextExpiresAt.toMillis(),
      ghlTokenSource: "location",
      ghlAuthStatus: null,
      ghlAuthError: FieldValue.delete(),
      ghlAuthErrorUpdatedAt: FieldValue.delete(),
      ghlLastTokenRefreshAt: FieldValue.serverTimestamp(),
      ...(readString(refreshed.companyId) ? { companyId: readString(refreshed.companyId) } : {}),
      ...planFields(refreshed.planId),
    },
    { merge: true },
  );

  if (process.env.OAUTH_LOG === "on") {
    console.info("[oauth] plan capture (refresh)", {
      locationId: options.locationRef.id,
      planId: refreshed.planId ?? null,
      source: "location_refresh",
    });
  }

  return {
    accessToken: refreshed.access_token,
    refreshToken: nextRefreshToken,
    expiresAt: new Date(nextExpiresAt.toMillis()),
    refreshed: true,
  };
}

async function issueLocationAccessTokenViaAgency(options: {
  locationId: string;
  locationRef: DocumentReference;
  agencyId: string | null;
  locationCompanyId: string | null;
}): Promise<LocationTokenResult> {
  if (!options.agencyId) {
    throw new Error(`Location ${options.locationId} is not linked to an agency; cannot issue token via agency`);
  }

  const agencyToken = await ensureAgencyAccessToken(options.agencyId);
  const companyId = options.locationCompanyId ?? agencyToken.companyId;

  if (!companyId) {
    throw new Error(`Missing GoHighLevel companyId for agency ${options.agencyId}`);
  }

  const locationToken = await fetchLocationAccessTokenFromAgency({
    agencyAccessToken: agencyToken.accessToken,
    companyId,
    locationId: options.locationId,
  });

  const nextExpiresAt = Timestamp.fromMillis(Date.now() + locationToken.expires_in * 1000);

  await options.locationRef.set(
    {
      accessToken: locationToken.access_token,
      refreshToken: null,
      accessTokenExpiresAt: nextExpiresAt,
      expiresAt: nextExpiresAt.toMillis(),
      ghlTokenSource: "agency",
      ghlAuthStatus: null,
      ghlAuthError: FieldValue.delete(),
      ghlAuthErrorUpdatedAt: FieldValue.delete(),
      ghlLastTokenRefreshAt: FieldValue.serverTimestamp(),
      companyId,
      ...planFields(locationToken.planId),
    },
    { merge: true },
  );

  if (process.env.OAUTH_LOG === "on") {
    console.info("[oauth] plan capture (agency_mint)", {
      locationId: options.locationId,
      planId: locationToken.planId ?? null,
      source: "agency_mint",
    });
  }

  return {
    accessToken: locationToken.access_token,
    refreshToken: null,
    expiresAt: new Date(nextExpiresAt.toMillis()),
    refreshed: true,
  };
}

export async function ensureLocationAccessToken(
  locationId: string,
  options?: { force?: boolean },
): Promise<LocationTokenResult> {
  const { state, exists, ref } = await loadLocationTokenState(locationId);

  if (!exists) {
    throw new Error(`Location document ${locationId} does not exist`);
  }

  const force = options?.force === true;
  const expiresAtMillis = state.accessTokenExpiresAt?.toMillis() ?? null;

  if (state.refreshToken) {
    const needsRefresh =
      force || !state.accessToken || !expiresAtMillis || expiresAtMillis <= Date.now() + REFRESH_LEEWAY_MS;

    if (!needsRefresh && state.accessToken) {
      return {
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        expiresAt: expiresAtMillis ? new Date(expiresAtMillis) : null,
        refreshed: false,
      };
    }

    try {
      return await refreshLocationWithRefreshToken({
        locationRef: ref,
        refreshToken: state.refreshToken,
      });
    } catch (error) {
      if (error instanceof InvalidGhlRefreshTokenError) {
        try {
          const viaAgency = await issueLocationAccessTokenViaAgency({
            locationId,
            locationRef: ref,
            agencyId: state.agencyId,
            locationCompanyId: state.companyId,
          });

          if (process.env.NODE_ENV !== "production") {
            console.log(`[GHL] Issued location access token via agency fallback for ${locationId}`);
          }

          return viaAgency;
        } catch (attemptError) {
          await ref.set(
            {
              accessToken: null,
              refreshToken: null,
              accessTokenExpiresAt: null,
              expiresAt: null,
              ghlAuthStatus: "reauth_required",
              ghlAuthError:
                attemptError instanceof Error ? attemptError.message : (error as Error).message,
              ghlAuthErrorUpdatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );

          if (attemptError instanceof Error) {
            (error as Error).message = `${(error as Error).message}; agency fallback failed: ${attemptError.message}`;
          }

          if (
            error instanceof InvalidGhlRefreshTokenError &&
            attemptError instanceof InvalidGhlRefreshTokenError &&
            attemptError.detail
          ) {
            error.detail = attemptError.detail;
          }
        }
      }

      throw error;
    }
  }

  if (!force && state.accessToken && expiresAtMillis && expiresAtMillis > Date.now() + REFRESH_LEEWAY_MS) {
    return {
      accessToken: state.accessToken,
      refreshToken: null,
      expiresAt: new Date(expiresAtMillis),
      refreshed: false,
    };
  }

  try {
    const viaAgency = await issueLocationAccessTokenViaAgency({
      locationId,
      locationRef: ref,
      agencyId: state.agencyId,
      locationCompanyId: state.companyId,
    });

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[GHL] Issued location access token via agency fallback for ${locationId} (no stored refresh token)`,
      );
    }

    return viaAgency;
  } catch (error) {
    await ref.set(
      {
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
        expiresAt: null,
        ghlAuthStatus: "reauth_required",
        ghlAuthError:
          error instanceof Error ? error.message : "Unable to issue GoHighLevel access token",
        ghlAuthErrorUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    throw error;
  }
}

export async function getValidAccessTokenForLocation(
  locationId: string,
  options?: { force?: boolean },
): Promise<string> {
  const token = await ensureLocationAccessToken(locationId, options);
  return token.accessToken;
}

export function exchangeRefreshToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<RefreshExchangeResponse>;
export function exchangeRefreshToken(refreshToken: string): Promise<RefreshExchangeResponse>;
export function exchangeRefreshToken(
  refreshToken: string,
  clientId?: string,
  clientSecret?: string,
): Promise<RefreshExchangeResponse> {
  return fetchRefreshedToken(refreshToken, "Location", { clientId, clientSecret });
}
