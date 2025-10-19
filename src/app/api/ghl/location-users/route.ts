// File: src/app/api/ghl/location-users/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
import { exchangeRefreshToken } from "@/lib/ghlTokens";
import { ghlFetch } from "@/lib/ghlClient";
import {
  lcHeaders,
  ghlMintLocationTokenUrl,
} from "@/lib/ghl";

export const runtime = "nodejs";

function err(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

type GhlUsersResponse =
  | { users?: Array<{ id: string; name?: string; email?: string; role?: string }> }
  | { data?: { users?: Array<{ id: string; name?: string; email?: string; role?: string }> } };

async function getLocationDoc(locationId: string) {
  const ref = db().collection("locations").doc(locationId);
  const snap = await ref.get();
  return { ref, snap, data: (snap.data() || {}) as Record<string, unknown> };
}

function readString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

async function mintLocationRefreshToken(params: {
  agencyAccessToken: string;
  agencyId: string;
  locationId: string;
}): Promise<string | null> {
  const resp = await fetch(ghlMintLocationTokenUrl(), {
    method: "POST",
    headers: { ...lcHeaders(params.agencyAccessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: params.agencyId, locationId: params.locationId }),
  });

  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    // surface a short sample for debugging
    throw new Error(`mint failed ${resp.status}: ${text.slice(0, 300)}`);
  }

  try {
    const j = JSON.parse(text) as { data?: { refresh_token?: string }; refresh_token?: string };
    const rt = j?.data?.refresh_token ?? j?.refresh_token ?? "";
    return rt || null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const locationId =
      u.searchParams.get("location_id") ||
      u.searchParams.get("locationId") ||
      "";

    if (!locationId) return err(400, "MISSING_LOCATION_ID", "Provide ?location_id");

    // Load location row
    const { ref: locRef, snap: locSnap, data: locData } = await getLocationDoc(locationId);
    if (!locSnap.exists) return err(404, "UNKNOWN_LOCATION", "Location not found");

    const refreshToken = readString(locData.refreshToken);
    const agencyId = readString(locData.agencyId);
    if (!refreshToken) {
      return err(409, "NO_REFRESH_TOKEN", "Location not installed / no refreshToken");
    }

    // Helper to call Users API with a given access token
    const fetchUsers = async (accessToken: string) => {
      const json = await ghlFetch<GhlUsersResponse>("/users/", {
        accessToken,
        query: { locationId }, // explicit for widest compatibility
      });
      const users =
        (json as { users?: Array<{ id: string; name?: string; email?: string; role?: string }> }).users ??
        (json as { data?: { users?: Array<{ id: string; name?: string; email?: string; role?: string }> } }).data?.users ??
        [];
      return users;
    };

    // 1) Try exchanging the location refresh token
    let accessToken: string | null = null;
    try {
      const tok = await exchangeRefreshToken(refreshToken);
      accessToken = tok.access_token || null;
    } catch (e) {
      const msg = (e as Error).message || "";
      const isInvalidGrant = /invalid_grant/i.test(msg);

      if (!isInvalidGrant) {
        return err(502, "TOKEN_EXCHANGE_FAILED", `refresh exchange failed: ${msg}`);
      }

      // 2) Self-heal path for invalid_grant
      if (!agencyId) {
        return err(
          502,
          "TOKEN_INVALID_NEEDS_MINT",
          "Location refresh token is invalid and agencyId is unknown; cannot mint a new one."
        );
      }

      // 2a) Load agency refresh token
      const agSnap = await db().collection("agencies").doc(agencyId).get();
      const agData = (agSnap.data() || {}) as Record<string, unknown>;
      const agencyRefresh = readString(agData.refreshToken);
      if (!agencyRefresh) {
        return err(
          502,
          "TOKEN_INVALID_NEEDS_AGENCY_REFRESH",
          "Location refresh token is invalid and agency has no refresh token to mint a new one."
        );
      }

      // 2b) Exchange agency refresh → agency access
      let agencyAccessToken = "";
      try {
        const tok = await exchangeRefreshToken(agencyRefresh);
        agencyAccessToken = tok.access_token || "";
      } catch (e2) {
        return err(
          502,
          "AGENCY_TOKEN_EXCHANGE_FAILED",
          `Failed to exchange agency refresh token: ${(e2 as Error).message}`
        );
      }
      if (!agencyAccessToken) {
        return err(502, "AGENCY_ACCESS_EMPTY", "Agency token exchange returned no access token");
      }

      // 2c) Mint a brand new location refresh token
      let newLocationRefresh = "";
      try {
        const minted = await mintLocationRefreshToken({
          agencyAccessToken,
          agencyId,
          locationId,
        });
        newLocationRefresh = minted || "";
      } catch (e3) {
        return err(
          502,
          "MINT_LOCATION_REFRESH_FAILED",
          `Could not mint a new location refresh token: ${(e3 as Error).message}`
        );
      }
      if (!newLocationRefresh) {
        return err(
          502,
          "MINT_LOCATION_REFRESH_EMPTY",
          "Minted response did not contain a refresh token"
        );
      }

      // 2d) Persist the new refresh token back to the location doc
      await locRef.set({ refreshToken: newLocationRefresh }, { merge: true });

      // 2e) Exchange the newly-minted refresh token → fresh access token
      const tok2 = await exchangeRefreshToken(newLocationRefresh);
      accessToken = tok2.access_token || null;
      if (!accessToken) {
        return err(502, "NEW_ACCESS_EMPTY", "Newly minted refresh token did not yield an access token");
      }
    }

    // 3) With a valid access token, fetch users
    const users = await fetchUsers(accessToken!);

    return NextResponse.json(
      { users },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return err(502, "GHL_ERROR", msg);
  }
}
