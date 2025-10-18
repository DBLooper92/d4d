import { NextRequest, NextResponse } from "next/server";
import { getValidLocationAccessToken } from "@/lib/ghlTokens";
import { ghlFetch } from "@/lib/ghlHttp";
import { env } from "@/lib/env";

type GhlUsersResponse = { users?: unknown[] };

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// GET /api/ghl/location-users?location_id=...
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const locationId = searchParams.get("location_id");
    if (!locationId) {
      return NextResponse.json({ error: "Missing location_id" }, { status: 400 });
    }

    // Ensure we have a fresh Location token
    const { token } = await getValidLocationAccessToken({
      locationId,
      clientId: env.GHL_CLIENT_ID,
      clientSecret: env.GHL_CLIENT_SECRET,
    });

    // Call Get User by Location with required Version header
    const data = await ghlFetch<GhlUsersResponse>(`/users/?locationId=${encodeURIComponent(locationId)}`, {
      method: "GET",
      token,
      version: "2021-07-28",
    });

    return NextResponse.json({ users: data.users ?? [] });
  } catch (err: unknown) {
    const message = errorMessage(err);
    const reconnect = /No valid token/i.test(message);
    const status = reconnect ? 401 : 500;
    return NextResponse.json(
      {
        error: reconnect
          ? "No valid token for this location. Reconnect OAuth or reinstall."
          : "Failed to load users.",
        detail: message,
      },
      { status }
    );
  }
}
