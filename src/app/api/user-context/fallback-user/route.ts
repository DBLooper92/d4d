import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
import { exchangeRefreshToken } from "@/lib/ghlTokens";
import { getGhlConfig, lcHeaders, olog } from "@/lib/ghl";

export const runtime = "nodejs";

type FallbackBody = {
  locationId: string;
};

type UserCore = {
  id?: string;
  _id?: string;
  userId?: string;
  role?: string;
  userRole?: string;
  email?: string;
  name?: string;
};

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function extractSingleUser(json: unknown): UserCore | null {
  // API responses have varied over time; handle a few shapes without `any`.
  if (Array.isArray(json)) {
    const first = json.find((x) => isRecord(x) && (x.id || x._id || x.userId));
    return (first as UserCore) || null;
  }
  if (isRecord(json)) {
    // common shapes: { users: [...] } or { data: {...} } or a direct object
    const users = json["users"];
    if (Array.isArray(users)) {
      const first = users.find((x) => isRecord(x) && (x.id || x._id || x.userId));
      return (first as UserCore) || null;
    }
    const data = json["data"];
    if (isRecord(data)) {
      return data as UserCore;
    }
    return json as UserCore;
  }
  return null;
}

export async function POST(req: Request) {
  try {
    const { locationId } = (await req.json()) as FallbackBody;
    if (!locationId || !locationId.trim()) {
      return NextResponse.json({ error: "Missing locationId" }, { status: 400 });
    }

    // 1) Load the location's refresh token
    const loc = await db().collection("locations").doc(locationId).get();
    if (!loc.exists) return NextResponse.json({ error: "Unknown location" }, { status: 404 });
    const refreshToken = String((loc.data() || {}).refreshToken || "");
    if (!refreshToken) {
      return NextResponse.json({ error: "Location not installed / no refreshToken" }, { status: 409 });
    }

    // 2) Exchange → location access token (must be location-scoped)
    const { clientId, clientSecret } = getGhlConfig();
    const tok = await exchangeRefreshToken(refreshToken, clientId, clientSecret);
    const access = tok.access_token || "";
    if (!access) return NextResponse.json({ error: "Token exchange failed" }, { status: 502 });

    // 3) Call Users API: Get User by Location (requires users.readonly)
    const url = new URL("https://services.leadconnectorhq.com/users/");
    url.searchParams.set("locationId", locationId);

    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: lcHeaders(access),
    });

    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      olog("fallback-user fetch failed", { status: resp.status, sample: text.slice(0, 400) });
      return NextResponse.json({ error: `Users API failed (${resp.status})` }, { status: 502 });
    }

    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* ignore */
    }

    const u = extractSingleUser(json);
    if (!u) return NextResponse.json({ userId: null, role: null }, { status: 200 });

    const userId = pickString(u as Record<string, unknown>, ["id", "_id", "userId"]);
    const role = pickString(u as Record<string, unknown>, ["role", "userRole"]);

    return NextResponse.json(
      {
        userId: userId ?? null,
        role: role ?? null,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: `fallback failed: ${(e as Error).message}` }, { status: 500 });
  }
}
