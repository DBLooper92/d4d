// src/app/api/ghl/location-users/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getValidLocationAccessToken } from "@/lib/ghlTokens";
import { ghlFetch } from "@/lib/ghlHttp";
import { env } from "@/lib/env";

type GhlUsersResponse = { users?: unknown[] };

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

// GET /api/ghl/location-users?location_id=...
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const locationId = searchParams.get("location_id");
    if (!locationId) {
      return NextResponse.json({ error: "Missing location_id" }, { status: 400 });
    }

    const { token } = await getValidLocationAccessToken({
      locationId,
      clientId: env.GHL_CLIENT_ID,
      clientSecret: env.GHL_CLIENT_SECRET,
    });

    // Note: no trailing slash before '?'
    const data = await ghlFetch<GhlUsersResponse>(
      `/users?locationId=${encodeURIComponent(locationId)}`,
      { method: "GET", token, version: "2021-07-28" }
    );

    return NextResponse.json({ users: data.users ?? [] });
  } catch (err: unknown) {
    const message = errorMessage(err);

    // Map common LC auth errors more clearly to the UI
    const isNoToken = /No valid token/i.test(message);
    const isUnauthorized = /\b401\b|Unauthorized|invalid token/i.test(message);
    const isForbidden = /\b403\b|Forbidden|insufficient scope|scope/i.test(message);

    const status = isNoToken ? 401 : isUnauthorized ? 401 : isForbidden ? 403 : 500;
    const hint =
      isNoToken
        ? "No valid token for this location. Reconnect OAuth or reinstall."
        : isUnauthorized
          ? "Token invalid/expired. Reconnect OAuth."
          : isForbidden
            ? "Missing users.readonly on this install."
            : "Failed to load users.";

    return NextResponse.json(
      {
        error: hint,
        detail: message.slice(0, 400),
      },
      { status }
    );
  }
}
