import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
import { exchangeRefreshToken } from "@/lib/ghlTokens";
import { getGhlConfig, lcHeaders, olog } from "@/lib/ghl";

export const runtime = "nodejs";

type FallbackBody = { locationId: string };

type UserCore = {
  id?: string;
  _id?: string;
  userId?: string;
  role?: string;
  userRole?: string;
  email?: string;
  name?: string;
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function collectUsers(json: unknown): UserCore[] {
  if (Array.isArray(json)) return json.filter(isObj) as UserCore[];
  if (!isObj(json)) return [];
  const keys = Object.keys(json);

  // Common shapes we’ve seen in the wild
  const fromUsers = Array.isArray((json as { users?: unknown }).users)
    ? ((json as { users: unknown }).users as unknown[]).filter(isObj) as UserCore[]
    : [];
  if (fromUsers.length) return fromUsers;

  const fromDataArr = Array.isArray((json as { data?: unknown }).data)
    ? ((json as { data: unknown }).data as unknown[]).filter(isObj) as UserCore[]
    : [];
  if (fromDataArr.length) return fromDataArr;

  const fromDataObj = isObj((json as { data?: unknown }).data) ? [((json as { data: unknown }).data as UserCore)] : [];
  if (fromDataObj.length) return fromDataObj;

  const fromUserObj = isObj((json as { user?: unknown }).user) ? [((json as { user: unknown }).user as UserCore)] : [];
  if (fromUserObj.length) return fromUserObj;

  // As a last resort, treat root as a single user-like object
  const looksLikeUser =
    keys.some((k) => k === "id" || k === "_id" || k === "userId") ||
    keys.some((k) => k === "role" || k === "userRole");
  return looksLikeUser ? [json as UserCore] : [];
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

    // 2) Exchange → location access token
    const { clientId, clientSecret } = getGhlConfig();
    const tok = await exchangeRefreshToken(refreshToken, clientId, clientSecret);
    const access = tok.access_token || "";
    if (!access) return NextResponse.json({ error: "Token exchange failed" }, { status: 502 });

    // 3) Correct Users API: /users/search with locationId
    const url = new URL("https://services.leadconnectorhq.com/users/search");
    url.searchParams.set("locationId", locationId);
    // (Optional) tune page size if supported by your integration:
    // url.searchParams.set("limit", "25");

    const resp = await fetch(url.toString(), { method: "GET", headers: lcHeaders(access) });
    const text = await resp.text().catch(() => "");

    if (!resp.ok) {
      olog("fallback-user fetch failed", { status: resp.status, sample: text.slice(0, 300) });
      return NextResponse.json({ error: `Users API failed (${resp.status})` }, { status: 502 });
    }

    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    const users = collectUsers(json);
    olog("fallback-user users discovered", { count: users.length });

    if (!users.length) {
      return NextResponse.json({ userId: null, role: null }, { status: 200, headers: { "Cache-Control": "no-store" } });
    }

    // Heuristic: prefer an Admin-like role if present, else the first.
    const rank = (u: UserCore) => {
      const r = (u.role || u.userRole || "").toLowerCase();
      if (r.includes("owner")) return 1;
      if (r.includes("admin")) return 2;
      return 3;
    };
    users.sort((a, b) => rank(a) - rank(b));
    const picked = users[0];

    const userId = pickString(picked as Record<string, unknown>, ["id", "_id", "userId"]);
    const role = pickString(picked as Record<string, unknown>, ["role", "userRole"]);

    return NextResponse.json(
      { userId: userId ?? null, role: role ?? null },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = (e as Error).message || String(e);
    olog("fallback-user error", { msg });
    return NextResponse.json({ error: `fallback failed: ${msg}` }, { status: 500 });
  }
}
