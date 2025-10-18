import { db, Timestamp } from "@/lib/firebaseAdmin";
import { ghlFetch } from "@/lib/ghlHttp";

// Data shape we persist (superset for compatibility)
type TokenDoc = {
  // Common
  locationId: string;
  companyId?: string;      // aka agencyId in some places
  agencyId?: string;       // alias – we will map to companyId if present
  userType?: "Company" | "Location";
  scopes?: string;

  // Active access/refresh
  accessToken?: string;
  refreshToken?: string;

  // New-style expiry we maintain (server timestamp)
  accessTokenExpiresAt?: FirebaseFirestore.Timestamp;

  // Existing numeric expiry your db currently stores (epoch seconds)
  expiresAt?: number;

  // If we only have Agency token but need Location token on demand
  agencyAccessToken?: string;
  agencyRefreshToken?: string;
  agencyAccessTokenExpiresAt?: FirebaseFirestore.Timestamp;
};

// Try multiple locations; return {ref,data} for the first that exists; else create at preferred.
// NOTE: We now include your root "locations/{id}" doc (per your screenshot).
const tokenDocCandidates = (locationId: string) => ([
  db.collection("locations").doc(locationId),                                         // ✅ your current doc
  db.collection("oauth").doc("locations").collection("byId").doc(locationId),        // alt
  db.collection("locations").doc(locationId).collection("private").doc("oauth"),     // alt
  db.collection("ghl").doc("locations").collection("byId").doc(locationId),          // alt (preferred fallback)
]);

async function loadTokenDoc(locationId: string) {
  const cands = tokenDocCandidates(locationId);
  for (const ref of cands) {
    const snap = await ref.get();
    if (snap.exists) {
      const raw = snap.data() as TokenDoc;

      // Normalize aliases
      const companyId = raw.companyId ?? raw.agencyId;

      // Prefer Timestamp, but support numeric expiresAt (epoch seconds) from existing installs
      const expiresTs = raw.accessTokenExpiresAt
        ? raw.accessTokenExpiresAt
        : (typeof raw.expiresAt === "number" ? Timestamp.fromMillis(raw.expiresAt * 1000) : undefined);

      const data: TokenDoc = {
        ...raw,
        companyId,
        accessTokenExpiresAt: expiresTs,
      };
      return { ref, data };
    }
  }
  // Create at the last candidate (stable), but we won't force a schema move.
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

// ---- Refresh helpers (per GHL docs) ----

// Refresh an access token using refresh_token (keep same user_type)
async function refreshAccessToken(params: {
  refreshToken: string;
  userType: "Company" | "Location";
  clientId: string;
  clientSecret: string;
  redirectUri?: string; // usually the one you used on install
}) {
  // application/x-www-form-urlencoded required for refresh flow.
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

// Mint a Location token from an Agency token.
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

// Primary API used by routes
export async function getValidLocationAccessToken(
  opts: GetTokenOpts
): Promise<{ token: string; scopes?: string }> {
  const { locationId, clientId, clientSecret, redirectUri } = opts;
  const { ref, data } = await loadTokenDoc(locationId);

  // Map alias if needed
  const companyId = data.companyId ?? data.agencyId;

  // 1) If we already have a Location token and it's not expired, use it.
  if (data.userType === "Location" && data.accessToken && !isExpired(data.accessTokenExpiresAt)) {
    return { token: data.accessToken, scopes: data.scopes };
  }

  // 2) If we have a Location refresh token -> refresh it.
  if (data.userType === "Location" && data.refreshToken) {
    try {
      const r = await refreshAccessToken({
        refreshToken: data.refreshToken,
        userType: "Location",
        clientId,
        clientSecret,
        redirectUri,
      });
      const expiresAtTs = Timestamp.fromMillis(Date.now() + (r.expires_in - 60) * 1000);
      await ref.set({
        userType: r.userType,
        accessToken: r.access_token,
        refreshToken: r.refresh_token,
        accessTokenExpiresAt: expiresAtTs,
        // keep numeric `expiresAt` in sync for older code
        expiresAt: toEpochSeconds(expiresAtTs),
        scopes: r.scope,
        companyId: r.companyId ?? companyId,
        locationId: r.locationId ?? locationId,
      }, { merge: true });

      return { token: r.access_token, scopes: r.scope };
    } catch {
      // refresh failed; fall through to agency-mint path
    }
  }

  // 3) If we have an Agency (Company) token, mint a fresh Location token.
  if (data.userType === "Company" || data.agencyAccessToken || data.accessToken) {
    const agencyToken = (data.userType === "Company" ? data.accessToken : data.agencyAccessToken) || undefined;
    if (!agencyToken) throw new Error("No valid token for this location. Reconnect OAuth or reinstall.");
    if (!companyId) throw new Error("Missing companyId/agencyId for location; cannot mint location token.");

    const r = await mintLocationTokenFromAgency({
      agencyAccessToken: agencyToken,
      companyId,
      locationId,
    });

    const expiresAtTs = Timestamp.fromMillis(Date.now() + (r.expires_in - 60) * 1000);
    await ref.set({
      userType: "Location",
      accessToken: r.access_token,
      // locationToken mint may or may not include refresh_token; if absent, we will mint again from agency on expiry.
      refreshToken: r.refresh_token ?? data.refreshToken,
      accessTokenExpiresAt: expiresAtTs,
      expiresAt: toEpochSeconds(expiresAtTs),
      scopes: r.scope,
      locationId: r.locationId ?? locationId,
    }, { merge: true });

    return { token: r.access_token, scopes: r.scope };
  }

  // 4) Nothing usable
  throw new Error("No valid token for this location. Reconnect OAuth or reinstall.");
}

/* ---------- Compatibility exports (keep existing routes compiling) ---------- */

// Some files import this older name; provide a thin wrapper.
export async function getValidAccessTokenForLocation(args: {
  locationId: string;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}): Promise<{ token: string; scopes?: string }> {
  return getValidLocationAccessToken(args);
}

// Some routes import `exchangeRefreshToken`; surface the internal helper.
export async function exchangeRefreshToken(params: {
  refreshToken: string;
  userType: "Company" | "Location";
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}) {
  return refreshAccessToken(params);
}
