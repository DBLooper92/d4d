// src/app/api/ghl/location-users/route.ts
import { NextResponse } from "next/server";
import { ghlFetch, type GhlUser } from "@/lib/ghlClient";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";

type UserRow = {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
};

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const locationId =
      searchParams.get("location_id") ||
      searchParams.get("locationId") ||
      searchParams.get("location") ||
      "";

    if (!locationId) {
      return NextResponse.json({ error: "Missing location_id" }, { status: 400 });
    }

    const accessToken = await getValidAccessTokenForLocation(locationId);

    // HighLevel v2: Search Users (location-scoped)
    const data = await ghlFetch<{ users?: GhlUser[] }>("/users/search", {
      accessToken,
      query: { locationId, limit: 200 },
    });

    const items: UserRow[] = (data.users || []).map((u) => {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || "(no name)";
      return {
        id: u.id,
        name,
        email: u.email || null,
        role: u.role || null,
      };
    });

    return NextResponse.json(
      { items, count: items.length },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return NextResponse.json({ error: `location-users failed: ${msg}` }, { status: 500 });
  }
}
