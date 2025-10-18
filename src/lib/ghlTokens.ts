// File: src/lib/ghlTokens.ts
import { db, Timestamp } from "@/lib/firebaseAdmin";
import { ghlFetch } from "@/lib/ghlHttp";

// Data shape we persist (superset for compatibility)
type TokenDoc = {
  locationId: string;
  companyId?: string;      // aka agencyId
  agencyId?: string;       // alias
  userType?: "Company" | "Location";
  scopes?: string;

  accessToken?: string;
  refreshToken?: string;

  accessTokenExpiresAt?: FirebaseFirestore.Timestamp;
  expiresAt?: number; // epoch seconds (legacy)

  agencyAccessToken?: string;
  agencyRefreshToken?: string;
  agencyAccessTokenExpiresAt?: FirebaseFirestore.Timestamp;
};

// Read from several possible locations
const tokenDocCandidates = (locationId: string) => ([
  db().collection("locations").doc(locationId),
  db().collection("oauth").doc("locations").collection("byId").doc(locationId),
  db().collection("locations").doc(locationId).collection("private").doc("oauth"),
  db().collection("ghl").doc("locations").collection("byId").doc(locationId),
]);

type Loaded = { ref: FirebaseFirestore.DocumentReference; data: TokenDoc };

function coalesceTokenDocs(parts: Array<{ data?: TokenDoc }>): TokenDoc {
  const merged: TokenDoc = { locationId: "", scopes: undefined };
  for (const p of parts) {
    if (!p?.data) continue;
    const d = p.data;
    merged.locationId = merged.locationId || d.locationId || "";
    merged.companyId = merged.companyId || d.companyId || d.agencyId;
    merged.agencyId = merged.agencyId || d.agencyId || d.companyId;
    merged.userType = merged.userType || d.userType;
    merged.scopes = merged.scopes || d.scopes;

    if (d.accessToken) merged.accessToken = merged.accessToken || d.accessToken;
    if (d.accessTokenExpiresAt) merged.accessTokenExpiresAt = merged.accessTokenExpiresAt || d.accessTokenExpiresAt;
    if (typeof d.expiresAt === "number") merged.expiresAt = merged.expiresAt || d.expiresAt;

    if (d.refreshToken) merged.refreshToken = merged.refreshToken || d.refreshToken;
    if (d.agencyAccessToken) merged.agencyAccessToken = merged.agencyAccessToken || d.agencyAccessToken;
    if (d.agencyRefreshToken) merged.agencyRefreshToken = merged.agencyRefreshToken || d.agencyRefreshToken;
    if (d.agencyAccessTokenExpiresAt) merged.agencyAccessTokenExpiresAt = merged.agencyAccessTokenExpiresAt || d.agencyAccessTokenExpiresAt;
  }
  if (!merged.accessTokenExpiresAt && typeof merged.expiresAt === "number") {
    merged.accessTokenExpiresAt = Timestamp.fromMillis(merged.expiresAt * 1000);
  }
  return merged;
}

async function loadTokenDoc(locationId: string): Promise<Loaded> {
  const cands = tokenDocCandidates(locationId);
  const snaps = await Promise.all(cands.map(ref => ref.get()));

  const existing: Array<{ ref: FirebaseFirestore.DocumentReference; data?: TokenDoc }> = snaps.map((snap, i) => ({
    ref: cands[i],
    data: snap.exists ? (snap.data() as TokenDoc) : undefined,
  }));

  if (existing.every(e => !e.data)) {
    const lastRef = cands[cands.length - 1];
    await lastRef.set({ locationId }, { merge: true });
    const snap = await lastRef.get();
    return { ref: lastRef, data: (snap.data() as TokenDoc) ?? { locationId } };
  }

  const merged = coalesceTokenDocs(existing);
  const chosen = existing.find(e =>
    e.data && (e.data.refreshToken || e.data.accessToken || e.data.agencyAccessToken)
  ) || existing.find(e => e.data) || existing[existing.length - 1];

  const companyId = merged.companyId ?? merged.agencyId;
  const expiresTs = merged.accessTokenExpiresAt
    ? merged.accessTokenExpiresAt
    : (typeof merged.expiresAt === "number" ? Timestamp.fromMillis(merged.expiresAt * 1000) : undefined);

  const normalized: TokenDoc = { ...merged, companyId, accessTokenExpiresAt: expiresTs, locationId };

  return { ref: chosen.ref, data: normalized };
}

function toEpochSeconds(ts?: FirebaseFirestore.Timestamp | null): number | undefined {
  return ts ? Math.floor(ts.toMillis() / 1000) : undefined;
}
function isExpired(ts?: FirebaseFirestore.Timestamp | null, skewSec = 90): boolean {
  if (!ts) return true;
  return ts.toMillis() <= Date.now() + skewSec * 1000;
}

// ---- Refresh helpers ----
type RefreshParams = {
  refreshToken: string;
  userType?: "Company" | "Location";
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
};

async function refreshAccessToken(params: Required<Pick<RefreshParams,"refreshToken"|"clientId"|"clientSecret">> & {
  userType?: "Company" | "Location";
  redirectUri?: string;
}) {
  const form = new URLSearchParams();
  form.set("client_id", params.clientId);
  form.set("client_secret", params.clientSecret);
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", params.refreshToken);
  if (params.userType) form.set("user_type", params.userType);
  if (params.redirectUri) form.set("redirect_uri", params.redirectUri);

  type Resp = {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    userType: "Company" | "Location";
    scope?: string;
    companyId?: string;
    locationId?: string;
  };
  return ghlFetch<Resp>("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    rawBody: form.toString(),
  });
}

// Support legacy call signature
export async function exchangeRefreshToken(
  a: string | RefreshParams,
  b?: string,
  c?: string
) {
  if (typeof a === "string") {
    if (!b || !c) throw new Error("exchangeRefreshToken legacy call requires (refreshToken, clientId, clientSecret)");
    return refreshAccessToken({ refreshToken: a, clientId: b, clientSecret: c, userType: "Location" });
  }
  const { refreshToken, clientId, clientSecret, userType, redirectUri } = a;
  return refreshAccessToken({ refreshToken, clientId, clientSecret, userType, redirectUri });
}

// POST /oauth/locationToken via agency
async function mintLocationTokenFromAgency(params: {
  agencyAccessToken: string;
  companyId: string;
  locationId: string;
}) {
  type Resp = {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    userType: "Location";
    scope?: string;
    locationId: string;
    companyId?: string;
  };
  return ghlFetch<Resp>("/oauth/locationToken", {
    method: "POST",
    token: params.agencyAccessToken,
    version: "2021-07-28",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    rawBody: new URLSearchParams({
      companyId: params.companyId,
      locationId: params.locationId,
    }).toString(),
  });
}

type GetTokenOpts = {
  locationId: string;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
};

export async function getValidLocationAccessToken(
  opts: GetTokenOpts
): Promise<{ token: string; scopes?: string }> {
  const { locationId, clientId, clientSecret, redirectUri } = opts;
  const { ref, data } = await loadTokenDoc(locationId);

  const companyId = data.companyId ?? data.agencyId;
  const assumedUserType = (data.userType || (data.refreshToken ? "Location" : undefined)) as "Location" | "Company" | undefined;

  // 1) If we have a non-expired access token, use it (treat undefined userType as OK for location flow)
  if (data.accessToken && !isExpired(data.accessTokenExpiresAt) && (assumedUserType === "Location" || !assumedUserType)) {
    return { token: data.accessToken, scopes: data.scopes };
  }

  // 2) If we have a refresh token, always try to refresh as Location. If that fails, retry without user_type.
  if (data.refreshToken) {
    try {
      const r1 = await refreshAccessToken({
        refreshToken: data.refreshToken,
        clientId,
        clientSecret,
        userType: "Location",
        redirectUri,
      });
      const expiresAtTs = Timestamp.fromMillis(Date.now() + (r1.expires_in - 60) * 1000);
      await ref.set({
        userType: r1.userType,
        accessToken: r1.access_token,
        refreshToken: r1.refresh_token || data.refreshToken,
        accessTokenExpiresAt: expiresAtTs,
        expiresAt: toEpochSeconds(expiresAtTs),
        scopes: r1.scope,
        companyId: r1.companyId ?? companyId,
        locationId: r1.locationId ?? locationId,
      }, { merge: true });
      return { token: r1.access_token, scopes: r1.scope };
    } catch {
      // Retry once without forcing user_type (some tenants/oauth configs reject the param)
      try {
        const r2 = await refreshAccessToken({
          refreshToken: data.refreshToken,
          clientId,
          clientSecret,
          redirectUri,
        });
        const expiresAtTs = Timestamp.fromMillis(Date.now() + (r2.expires_in - 60) * 1000);
        await ref.set({
          userType: r2.userType,
          accessToken: r2.access_token,
          refreshToken: r2.refresh_token || data.refreshToken,
          accessTokenExpiresAt: expiresAtTs,
          expiresAt: toEpochSeconds(expiresAtTs),
          scopes: r2.scope,
          companyId: r2.companyId ?? companyId,
          locationId: r2.locationId ?? locationId,
        }, { merge: true });
        return { token: r2.access_token, scopes: r2.scope };
      } catch {
        // fall through to possible agency mint
      }
    }
  }

  // 3) If we *know* we have an agency token (or explicit agencyAccessToken), mint a location token
  if (assumedUserType === "Company" || data.agencyAccessToken) {
    const agencyToken = (assumedUserType === "Company" ? data.accessToken : data.agencyAccessToken) || undefined;
    if (!agencyToken) throw new Error("No valid token for this location. Reconnect OAuth or reinstall.");
    if (!companyId) throw new Error("Missing companyId/agencyId for location; cannot mint location token.");

    const r = await mintLocationTokenFromAgency({ agencyAccessToken: agencyToken, companyId, locationId });
    const expiresAtTs = Timestamp.fromMillis(Date.now() + (r.expires_in - 60) * 1000);
    await ref.set({
      userType: "Location",
      accessToken: r.access_token,
      refreshToken: r.refresh_token ?? data.refreshToken,
      accessTokenExpiresAt: expiresAtTs,
      expiresAt: toEpochSeconds(expiresAtTs),
      scopes: r.scope,
      locationId: r.locationId ?? locationId,
    }, { merge: true });

    return { token: r.access_token, scopes: r.scope };
  }

  // 4) Nothing worked
  throw new Error("No valid token for this location. Reconnect OAuth or reinstall.");
}

// Back-compat
export async function getValidAccessTokenForLocation(args: GetTokenOpts) {
  return getValidLocationAccessToken(args);
}
