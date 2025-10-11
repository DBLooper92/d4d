// src/app/api/ghl/location-users/route.ts
import { NextResponse } from "next/server";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";
import { GHL_BASE } from "@/lib/ghlClient";

export const runtime = "nodejs";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

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

    const url = `${GHL_BASE}/locations/${encodeURIComponent(locationId)}/users`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const raw = await res.text();
    if (!res.ok) {
      return err(res.status === 401 ? 401 : 502, "GHL_ERROR", raw.slice(0, 800));
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return err(502, "GHL_BAD_JSON", raw.slice(0, 400));
    }

    return NextResponse.json(json, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return err(500, "UNEXPECTED", msg);
  }
}
