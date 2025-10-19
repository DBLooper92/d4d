// File: src/app/api/ghl/location-users/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
import { exchangeRefreshToken } from "@/lib/ghlTokens";
import { ghlFetch } from "@/lib/ghlClient";
import { lcHeaders, ghlMintLocationTokenUrl } from "@/lib/ghl";
import { getAgencyAccessToken } from "@/lib/agencyTokens";

export const runtime = "nodejs";

function err(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

type GhlUsersResponse =
  | { users?: Array<{ id: string; name?: string; email?: string; role?: string }> }
  | { data?: { users?: Array<{ id: string; name?: string; email?: string; role?: string }> } };

type LocDoc = {
  refreshToken?: string;
  agencyId?: string;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

async function readLocation(locationId: string) {
  const ref = db().collection("locations").doc(locationId);
  const snap = await ref.get();
  return { ref, snap, data: (snap.data() || {}) as LocDoc };
}

async function tryExchange(rt: string) {
  const tok = await exchangeRefreshToken(rt);
  return tok.access_token || "";
}

async function mintLocationRefreshToken(agencyAccessToken: string, agencyId: string, locationId: string) {
  const resp = await fetch(ghlMintLocationTokenUrl(), {
    method: "POST",
    headers: { ...lcHeaders(agencyAccessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: agencyId, locationId }),
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`mint failed ${resp.status}: ${text.slice(0, 300)}`);

  try {
    const j = JSON.parse(text) as { data?: { refresh_token?: string }; refresh_token?: string };
    const rt = j?.data?.refresh_token ?? j?.refresh_token ?? "";
    return rt || "";
  } catch {
    return "";
  }
}

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const locationId = u.searchParams.get("location_id") || u.searchParams.get("locationId") || "";
    if (!locationId) return err(400, "MISSING_LOCATION_ID", "Provide ?location_id");

    // 1) Read location (first read)
    const first = await readLocation(locationId);
    if (!first.snap.exists) return err(404, "UNKNOWN_LOCATION", "Location not found");
    const rt1 = asString(first.data.refreshToken);
    const agencyId = asString(first.data.agencyId);
    if (!rt1) return err(409, "NO_REFRESH_TOKEN", "Location not installed / no refreshToken");

    let accessToken = "";
    let lastErrMsg = "";

    // 2) Attempt #1 — exchange currently stored refresh token
    try {
      accessToken = await tryExchange(rt1);
    } catch (e) {
      lastErrMsg = (e as Error).message || "";
      const invalidGrant = /invalid_grant/i.test(lastErrMsg);

      if (!invalidGrant) {
        return err(502, "TOKEN_EXCHANGE_FAILED", `refresh exchange failed: ${lastErrMsg}`);
      }

      // 2a) Race-safe retry: re-read in case another request already updated it.
      const second = await readLocation(locationId);
      const rt2 = asString(second.data.refreshToken);

      if (rt2 && rt2 !== rt1) {
        try {
          accessToken = await tryExchange(rt2);
        } catch (e2) {
          lastErrMsg = (e2 as Error).message || "";
          // continue to agency mint fallback
        }
      }

      // 2b) Still no access? Use agency fallback to mint a NEW location refresh token
      if (!accessToken) {
        if (!agencyId) {
          return err(
            502,
            "TOKEN_INVALID_NEEDS_MINT",
            "Location refresh token is invalid and agencyId is unknown; cannot mint a new one.",
          );
        }

        // Get an agency-scoped access token using robust fallback logic
        const agencyAccessToken = await getAgencyAccessToken(agencyId);
        if (!agencyAccessToken) {
          return err(
            502,
            "AGENCY_TOKEN_UNAVAILABLE",
            "Could not obtain an agency access token to mint a new location refresh token.",
          );
        }

        // Mint new refresh token for this location
        let newLocRt = "";
        try {
          newLocRt = await mintLocationRefreshToken(agencyAccessToken, agencyId, locationId);
        } catch (e3) {
          return err(
            502,
            "MINT_LOCATION_REFRESH_FAILED",
            `Could not mint a new location refresh token: ${(e3 as Error).message}`,
          );
        }
        if (!newLocRt) {
          return err(502, "MINT_LOCATION_REFRESH_EMPTY", "Minted response did not contain a refresh token");
        }

        // Persist and exchange it
        await first.ref.set({ refreshToken: newLocRt }, { merge: true });
        try {
          accessToken = await tryExchange(newLocRt);
        } catch (e4) {
          return err(
            502,
            "NEW_ACCESS_EXCHANGE_FAILED",
            `Newly minted refresh token did not yield an access token: ${(e4 as Error).message}`,
          );
        }
      }
    }

    if (!accessToken) {
      return err(502, "ACCESS_TOKEN_EMPTY", `Exchange flow ended without an access token: ${lastErrMsg || "unknown"}`);
    }

    // 3) With a valid access token, fetch users (explicit locationId for widest compatibility)
    const json = await ghlFetch<GhlUsersResponse>("/users/", {
      accessToken,
      query: { locationId },
    });

    const users =
      (json as { users?: Array<{ id: string; name?: string; email?: string; role?: string }> }).users ??
      (json as { data?: { users?: Array<{ id: string; name?: string; email?: string; role?: string }> } }).data?.users ??
      [];

    return NextResponse.json(
      { users },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return err(502, "GHL_ERROR", msg);
  }
}
