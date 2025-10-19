// File: src/app/api/ghl/location-users/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
import { exchangeRefreshToken } from "@/lib/ghlTokens";
import { ghlFetch } from "@/lib/ghlClient";

export const runtime = "nodejs";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * The HighLevel "get users by location" endpoint returns a payload with a top-level
 * `users` array when the request is scoped to a location access token. In some
 * cases (older versions of the API) the array may be nested under a `data`
 * property. This union reflects both shapes so the response can be safely
 * narrowed when extracting the list of users.
 */
type GhlUsersResponse =
  | { users?: Array<{ id: string; name?: string; email?: string; role?: string }> }
  | { data?: { users?: Array<{ id: string; name?: string; email?: string; role?: string }> } };

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const locationId =
      u.searchParams.get("location_id") ||
      u.searchParams.get("locationId") ||
      "";

    if (!locationId) return err(400, "MISSING_LOCATION_ID", "Provide ?location_id");

    // 1) Load the location's refresh token directly from Firestore
    const locSnap = await db().collection("locations").doc(locationId).get();
    if (!locSnap.exists) return err(404, "UNKNOWN_LOCATION", "Location not found");
    const refreshToken = String((locSnap.data() || {}).refreshToken || "");
    if (!refreshToken) return err(409, "NO_REFRESH_TOKEN", "Location not installed / no refreshToken");

    // 2) ALWAYS exchange the refresh token for a fresh short-lived access token
    //    (do not reuse or persist any prior access token)
    const tok = await exchangeRefreshToken(refreshToken);
    const accessToken = tok.access_token;
    if (!accessToken) return err(502, "TOKEN_EXCHANGE_FAILED", "Failed to mint access token");

    // 3) Call Users API (scoped by location) using the fresh access token
    const json = await ghlFetch<GhlUsersResponse>("/users/", {
      accessToken,
      // Passing locationId explicitly is the safest cross-version behavior
      query: { locationId },
    });

    const users =
      (json as { users?: Array<{ id: string; name?: string; email?: string; role?: string }> }).users ??
      (json as { data?: { users?: Array<{ id: string; name?: string; email?: string; role?: string }> } }).data?.users ??
      [];

    return NextResponse.json(
      { users },
      {
        status: 200,
        headers: {
          // disable CDN and browser caching; location permissions may change
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return err(502, "GHL_ERROR", msg);
  }
}
