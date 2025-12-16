// src/app/api/ghl/location-users/route.ts
import { NextResponse } from "next/server";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";
import { ghlFetch } from "@/lib/ghlClient";
import { db } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

async function fetchAdminMeta(locationId: string) {
  try {
    const snap = await db().collection("locations").doc(locationId).get();
    const data = (snap.data() || {}) as { adminUid?: unknown; adminGhlUserId?: unknown };
    const adminUid =
      typeof data.adminUid === "string" && data.adminUid.trim() ? (data.adminUid as string).trim() : null;
    const adminGhlUserId =
      typeof data.adminGhlUserId === "string" && data.adminGhlUserId.trim()
        ? (data.adminGhlUserId as string).trim()
        : null;
    return {
      adminExists: Boolean(adminUid || adminGhlUserId),
      adminGhlUserId,
      adminUid,
    };
  } catch {
    return { adminExists: false, adminGhlUserId: null, adminUid: null };
  }
}

/**
 * The HighLevel "get users by location" endpoint returns a payload with a top‑level
 * `users` array when the request is scoped to a location access token. In some
 * cases (older versions of the API) the array may be nested under a `data`
 * property. This union reflects both shapes so the response can be safely
 * narrowed when extracting the list of users.
 */
type GhlUsersResponse =
  | { users?: Array<{ id: string; name?: string; email?: string; role?: string; firstName?: string; lastName?: string }> }
  | { data?: { users?: Array<{ id: string; name?: string; email?: string; role?: string; firstName?: string; lastName?: string }> } };

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const locationId = u.searchParams.get("location_id") || u.searchParams.get("locationId") || "";
    if (!locationId) return err(400, "MISSING_LOCATION_ID", "Provide ?location_id");

    const adminMetaPromise = fetchAdminMeta(locationId);
    let accessToken: string;
    try {
      accessToken = await getValidAccessTokenForLocation(locationId);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      return err(401, "TOKEN_UNAVAILABLE", msg);
    }

    /**
     * The v2 Users API exposes two ways to list users. The `/users/search` endpoint
     * requires a `companyId` and is intended for agency‑level tokens. When
     * operating with a location‑level access token (which is what the app uses),
     * the recommended endpoint is `GET /users/` which automatically scopes the
     * results to the active location. See the documentation for "Get User by
     * Location" in the HighLevel API for details【362954652847587†L5310-L5334】. Using
     * this endpoint avoids the need to know the parent company ID and aligns
     * with the OAuth scope `users.readonly`.
     */
    // Always pass the locationId as a query parameter.  The official
    // "Get User by Location" endpoint documentation specifies that a
    // `locationId` query parameter is required【724459568743161†L0-L18】.  While
    // recent versions of the API will automatically scope `/users/` when
    // using a sub‑account token, providing the ID explicitly ensures
    // compatibility with all documented behaviours.
    const json = await ghlFetch<GhlUsersResponse>("/users/", {
      accessToken,
      query: { locationId },
    });

    const users =
      (json as { users?: Array<{ id: string; name?: string; email?: string; role?: string }> }).users ??
      (json as { data?: { users?: Array<{ id: string; name?: string; email?: string; role?: string }> } }).data?.users ??
      [];

    const adminMeta = await adminMetaPromise;
    return NextResponse.json(
      {
        users,
        adminExists: adminMeta.adminExists,
        adminGhlUserId: adminMeta.adminGhlUserId ?? null,
      },
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
