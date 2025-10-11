// src/app/api/ghl/location-users/route.ts
import { NextResponse } from "next/server";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";
import { ghlFetch } from "@/lib/ghlClient";

export const runtime = "nodejs";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

type GhlUsersSearchOk =
  | { users?: Array<{ id: string; name?: string; email?: string; role?: string }> }
  | { data?: { users?: Array<{ id: string; name?: string; email?: string; role?: string }> } };

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const locationId = u.searchParams.get("location_id") || u.searchParams.get("locationId") || "";
    if (!locationId) return err(400, "MISSING_LOCATION_ID", "Provide ?location_id");

    let accessToken: string;
    try {
      accessToken = await getValidAccessTokenForLocation(locationId);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      return err(401, "TOKEN_UNAVAILABLE", msg);
    }

    const json = await ghlFetch<GhlUsersSearchOk>("/users/search", {
      accessToken,
      query: { locationId },
    });

    const users =
      (json as { users?: Array<{ id: string; name?: string; email?: string; role?: string }> }).users ??
      (json as { data?: { users?: Array<{ id: string; name?: string; email?: string; role?: string }> } }).data?.users ??
      [];

    return NextResponse.json(
      { users },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return err(502, "GHL_ERROR", msg);
  }
}
