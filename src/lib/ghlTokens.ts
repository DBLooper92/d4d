import { db, Timestamp } from "@/lib/firebaseAdmin";
import { ghlFetch } from "@/lib/ghlHttp";

// Data shape we persist
type TokenDoc = {
  // Common
  locationId: string;
  companyId?: string;
  userType?: "Company" | "Location";
  scopes?: string;
  // Active access/refresh
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: FirebaseFirestore.Timestamp; // server time
  // If we only have Agency token but need Location token on demand
  agencyAccessToken?: string;
  agencyRefreshToken?: string;
  agencyAccessTokenExpiresAt?: FirebaseFirestore.Timestamp;
};

// Try multiple locations; return {ref,data} for the first that exists; else create at preferred.
const tokenDocCandidates = (locationId: string) => ([
  db.collection("oauth").doc("locations").collection("byId").doc(locationId), // oauth/locations/byId/{locationId}
  db.collection("locations").doc(locationId).collection("private").doc("oauth"), // locations/{id}/private/oauth
  db.collection("ghl").doc("locations").collection("byId").doc(locationId), // ghl/locations/byId/{id}
]);

async function loadTokenDoc(locationId: string) {
  const cands = tokenDocCandidates(locationId);
  for (const ref of cands) {
    const snap = await ref.get();
    if (snap.exists) return { ref, data: snap.data() as TokenDoc };
  }
  // Create at preferred path if nothing exists.
  const ref = cands[cands.length - 1];
  await ref.set({ locationId }, { merge: true });
  const snap = await ref.get();
  return { ref, data: snap.data() as TokenDoc };
}

function isExpired(ts?: FirebaseFirestore.Timestamp, skewSec = 60): boolean {
  if (!ts) return true;
  const now = Timestamp.now().toMillis();
  return ts.toMillis() <= now + skewSec * 1000;
}

// ---- Refresh helpers (per GHL docs) ----

// Refresh an access token using refresh_token (keep same user_type)
async function refreshAccessToken(params: {
  refreshToken: string;
  userType: "Company" | "Location";
  clientId: string;
  clientSecret: string;
  redirectUri?: string; // usually the one you used on install
}) {
  // application/x-www-form-urlencoded required for refresh flow. :contentReference[oaicite:6]{index=6}
  const form = new URLSearchParams();
  form.set("client_id", params.clientId);
  form.set("client_secret", params.clientSecret);
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", params.refreshToken);
  form.set("user_type", params.userType);
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
  const r = await ghlFetch<Resp>("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    rawBody: form.toString(),
  });
  return r;
}

// Mint a Location token from an Agency token. :contentReference[oaicite:7]{index=7}
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
  const r = await ghlFetch<Resp>("/oauth/locationToken", {
    method: "POST",
    token: params.agencyAccessToken,
    version: "2021-07-28",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    rawBody: new URLSearchParams({
      companyId: params.companyId,
      locationId: params.locationId,
    }).toString(),
  });
  return r;
}

type GetTokenOpts = {
  locationId: string;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
};

export async function getValidLocationAccessToken(opts: GetTokenOpts): Promise<{ token: string; scopes?: string }> {
  const { locationId, clientId, clientSecret, redirectUri } = opts;
  const { ref, data } = await loadTokenDoc(locationId);

  // 1) If we already have a Location token and it's not expired, use it.
  if (data.userType === "Location" && data.accessToken && !isExpired(data.accessTokenExpiresAt)) {
    return { token: data.accessToken!, scopes: data.scopes };
  }

  // 2) If we have a Location refresh token -> refresh it. :contentReference[oaicite:8]{index=8}
  if (data.userType === "Location" && data.refreshToken) {
    try {
      const r = await refreshAccessToken({
        refreshToken: data.refreshToken,
        userType: "Location",
        clientId,
        clientSecret,
        redirectUri,
      });
      await ref.set({
        userType: r.userType,
        accessToken: r.access_token,
        refreshToken: r.refresh_token,
        accessTokenExpiresAt: Timestamp.fromMillis(Date.now() + (r.expires_in - 60) * 1000),
        scopes: r.scope,
        companyId: r.companyId ?? data.companyId,
        locationId: r.locationId ?? locationId,
      }, { merge: true });

      return { token: r.access_token, scopes: r.scope };
    } catch {
      // refresh failed; fall through to agency-mint path
    }
  }

  // 3) If we have an Agency (Company) token, mint a fresh Location token. :contentReference[oaicite:9]{index=9}
  if (data.userType === "Company" || data.agencyAccessToken) {
    const agencyToken = data.accessToken && data.userType === "Company"
      ? data.accessToken
      : data.agencyAccessToken;

    if (!agencyToken) throw new Error("No valid token for this location. Reconnect OAuth or reinstall.");

    if (!data.companyId) throw new Error("Missing companyId for location; cannot mint location token.");

    const r = await mintLocationTokenFromAgency({
      agencyAccessToken: agencyToken,
      companyId: data.companyId,
      locationId,
    });

    await ref.set({
      userType: "Location",
      accessToken: r.access_token,
      // locationToken mint may or may not include refresh_token; if absent, we will mint again from agency on expiry.
      refreshToken: r.refresh_token ?? data.refreshToken,
      accessTokenExpiresAt: Timestamp.fromMillis(Date.now() + (r.expires_in - 60) * 1000),
      scopes: r.scope,
      locationId: r.locationId ?? locationId,
    }, { merge: true });

    return { token: r.access_token, scopes: r.scope };
  }

  // 4) Nothing usable
  throw new Error("No valid token for this location. Reconnect OAuth or reinstall.");
}
