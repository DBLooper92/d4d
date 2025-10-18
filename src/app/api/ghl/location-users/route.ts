// src/app/api/ghl/location-users/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getValidAccessTokenForLocation, ghlFetch } from "@/lib/ghlTokens";

const GHL_BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type GhlUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

type GhlUsersResponseA = { users?: GhlUser[] };
type GhlUsersResponseB = { data?: { users?: GhlUser[] } };

function json(status: number, body: unknown) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function parseUsers(payload: unknown): GhlUser[] {
  if (!isObject(payload)) return [];
  const a = (payload as GhlUsersResponseA).users;
  if (Array.isArray(a)) return a;

  const data = (payload as GhlUsersResponseB).data;
  if (isObject(data) && Array.isArray((data as { users?: unknown }).users)) {
    return (data as { users: GhlUser[] }).users;
  }

  // Fallback: sometimes upstream returns { data: [...] }
  if (Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: GhlUser[] }).data;
  }

  return [];
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try {
      const text = await res.text();
      return { text };
    } catch {
      return null;
    }
  }
}

async function fetchUsers(locationId: string) {
  const accessToken = await getValidAccessTokenForLocation(locationId);

  const url = new URL(`${GHL_BASE}/users/`);
  url.searchParams.set("locationId", locationId);

  const upstream = await ghlFetch(url.toString(), {
    method: "GET",
    token: accessToken,
  });

  const payload = await safeJson(upstream);
  if (!upstream.ok) {
    return json(upstream.status, {
      error: "Failed to fetch users from GHL",
      status: upstream.status,
      details: payload,
    });
  }

  const users = parseUsers(payload);
  return json(200, { users });
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const locationId =
    url.searchParams.get("location_id")?.trim() ||
    url.searchParams.get("locationId")?.trim() ||
    "";

  if (!locationId) return json(400, { error: "location_id is required" });

  try {
    return await fetchUsers(locationId);
  } catch (e) {
    return json(401, {
      error:
        (e as Error)?.message ??
        "Unauthorized: could not resolve a valid access token for this location.",
    });
  }
}

export async function POST(req: NextRequest) {
  let locationId = "";
  try {
    const body = (await req.json()) as { locationId?: string; location_id?: string };
    locationId = (body.locationId || body.location_id || "").toString().trim();
  } catch {
    // ignore parse error
  }

  if (!locationId) return json(400, { error: "locationId is required" });

  try {
    return await fetchUsers(locationId);
  } catch (e) {
    return json(401, {
      error:
        (e as Error)?.message ??
        "Unauthorized: could not resolve a valid access token for this location.",
    });
  }
}
