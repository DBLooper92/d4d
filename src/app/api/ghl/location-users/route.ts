// src/app/api/ghl/location-users/route.ts
import { NextResponse } from "next/server";
import { getFreshAccessTokenForLocation } from "@/lib/ghlTokens";
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
    const locationId = u.searchParams.get("location_id") || u.searchParams.get("locationId") || "";
    if (!locationId) return err(400, "MISSING_LOCATION_ID", "Provide ?location_id");

    let accessToken: string;
    try {
      // Always exchange the refresh token and persist any rotated refresh token.
      accessToken = await getFreshAccessTokenForLocation(locationId);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      return err(401, "TOKEN_UNAVAILABLE", msg);
    }

    // Explicitly pass locationId for maximum compatibility with documented behavior.
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
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return err(502, "GHL_ERROR", msg);
  }
}
