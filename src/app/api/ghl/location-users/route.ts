// src/app/api/ghl/location-users/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";

const GHL_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";

export const runtime = "nodejs";
// Ensure this API route is never statically cached or pre-rendered
export const dynamic = "force-dynamic";

type GhlUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

type GhlUsersResponseA = { users?: GhlUser[] };
type GhlUsersResponseB = { data?: { users?: GhlUser[] } };

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function parseUsers(payload: unknown): GhlUser[] {
  if (!isObject(payload)) return [];
  // shape A
  const usersA = (payload as GhlUsersResponseA).users;
  if (Array.isArray(usersA)) return usersA as GhlUser[];
  // shape B
  const data = (payload as GhlUsersResponseB).data;
  if (isObject(data)) {
    const usersB = (data as { users?: unknown }).users;
    if (Array.isArray(usersB)) return usersB as GhlUser[];
  }
  return [];
}

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return await res.text();
  }
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const locationId =
    url.searchParams.get("location_id")?.trim() ||
    url.searchParams.get("locationId")?.trim() ||
    "";

  if (!locationId) {
    return json(400, { error: "location_id is required" });
  }

  let accessToken: string;
  try {
    accessToken = await getValidAccessTokenForLocation(locationId);
  } catch (e) {
    // Most common cause of 401 in your logs: no valid token for this location
    return json(401, {
      error:
        (e as Error)?.message ??
        "Unauthorized: could not resolve a valid access token for this location.",
    });
  }

  // GHL: Get users for a location
  const upstream = await fetch(`${GHL_BASE}/locations/${locationId}/users`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      Version: API_VERSION,
    },
    cache: "no-store",
  });

  const payload = await safeJson(upstream);

  if (!upstream.ok) {
    // Proxy useful upstream details for debugging, but keep a stable surface
    return json(502, {
      error: "Failed to fetch users from GHL",
      details: payload,
    });
  }

  const users = parseUsers(payload);

  return json(200, { users });
}
