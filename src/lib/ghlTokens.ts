// src/lib/ghlTokens.ts
import { db, Timestamp } from "@/lib/firebaseAdmin";
import { ghlFetch } from "@/lib/ghlHttp";

// Data shape we persist (superset for compatibility)
type TokenDoc = {
  locationId: string;
  companyId?: string;      // aka agencyId in some places
  agencyId?: string;       // alias – map to companyId if present
  userType?: "Company" | "Location";
  scopes?: string;

  accessToken?: string;
  refreshToken?: string;

  accessTokenExpiresAt?: FirebaseFirestore.Timestamp;
  expiresAt?: number;

  agencyAccessToken?: string;
  agencyRefreshToken?: string;
  agencyAccessTokenExpiresAt?: FirebaseFirestore.Timestamp;
};

// Read from several possible locations (your screenshot shows root locations/{id})
const tokenDocCandidates = (locationId: string) => ([
  db().collection("locations").doc(locationId),
  db().collection("oauth").doc("locations").collection("byId").doc(locationId),
  db().collection("locations").doc(locationId).collection("private").doc("oauth"),
  db().collection("ghl").doc("locations").collection("byId").doc(locationId),
]);

async function loadTokenDoc(locationId: string) {
  const cands = tokenDocCandidates(locationId);
  for (const ref of cands) {
    const snap = await ref.get();
    if (snap.exists) {
      const raw = snap.data() as TokenDoc;

      const companyId = raw.companyId ?? raw.agencyId;
      const expiresTs = raw.accessTokenExpiresAt
        ? raw.accessTokenExpiresAt
        : (typeof raw.expiresAt === "number" ? Timestamp.fromMillis(raw.expiresAt * 1000) : undefined);

      const data: TokenDoc = { ...raw, companyId, accessTokenExpiresAt: expiresTs };
      return { ref, data };
    }
  }
  const ref = cands[cands.length - 1];
  await ref.set({ locationId }, { merge: true });
  const snap = await ref.get();
  return { ref, data: snap.data() as TokenDoc };
}

function toEpochSeconds(ts?: FirebaseFirestore.Timestamp | null): number | undefined {
  return ts ? Math.floor(ts.toMillis() / 1000) : undefined;
}

function isExpired(ts?: FirebaseFirestore.Timestamp, skewSec = 60): boolean {
  if (!ts) return true;
  const now = Timestamp.now().toMillis();
  return ts.toMillis() <= now + skewSec * 1000;
}

// ---- Refresh helpers ----

type RefreshParams = {
  refreshToken: string;
  userType?: "Company" | "Location";
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
};

// POST /oauth/token (grant_type=refresh_token)
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

// Support both old and new call styles:
//   exchangeRefreshToken(rt, clientId, clientSecret)
//   exchangeRefreshToken({ refreshToken, clientId, clientSecret, userType?, redirectUri? })
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

// POST /oauth/locationToken
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

  if (data.userType === "Location" && data.accessToken && !isExpired(data.accessTokenExpiresAt)) {
    return { token: data.accessToken, scopes: data.scopes };
  }

  if (data.userType === "Location" && data.refreshToken) {
    try {
      const r = await refreshAccessToken({
        refreshToken: data.refreshToken,
        clientId,
        clientSecret,
        userType: "Location",
        redirectUri,
      });
      const expiresAtTs = Timestamp.fromMillis(Date.now() + (r.expires_in - 60) * 1000);
      await ref.set({
        userType: r.userType,
        accessToken: r.access_token,
        refreshToken: r.refresh_token,
        accessTokenExpiresAt: expiresAtTs,
        expiresAt: toEpochSeconds(expiresAtTs),
        scopes: r.scope,
        companyId: r.companyId ?? companyId,
        locationId: r.locationId ?? locationId,
      }, { merge: true });
      return { token: r.access_token, scopes: r.scope };
    } catch {
      // fall through to agency mint
    }
  }

  if (data.userType === "Company" || data.agencyAccessToken || data.accessToken) {
    const agencyToken = (data.userType === "Company" ? data.accessToken : data.agencyAccessToken) || undefined;
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

  throw new Error("No valid token for this location. Reconnect OAuth or reinstall.");
}

// Back-compat name
export async function getValidAccessTokenForLocation(args: GetTokenOpts) {
  return getValidLocationAccessToken(args);
}
