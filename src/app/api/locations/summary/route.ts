// src/app/api/locations/summary/route.ts
import { NextResponse } from "next/server";
import { db, getAdminApp } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

function cacheHeaders() {
  return { "Cache-Control": "no-store" };
}

function extractLocationId(req: Request): string {
  try {
    const url = new URL(req.url);
    const qp =
      url.searchParams.get("location_id") ||
      url.searchParams.get("locationId") ||
      url.searchParams.get("location") ||
      "";
    if (qp.trim()) return qp.trim();
  } catch {
    /* ignore */
  }
  return "";
}

function extractIdToken(req: Request): string | null {
  const authz = req.headers.get("authorization") || "";
  const bearer = authz.match(/Bearer\s+(.+)/i);
  if (bearer?.[1]) return bearer[1].trim();

  const headerToken = req.headers.get("x-id-token");
  if (headerToken && headerToken.trim()) return headerToken.trim();
  return null;
}

async function requireAuth(req: Request) {
  const token = extractIdToken(req);
  if (!token) {
    return { error: NextResponse.json({ error: "Missing auth token" }, { status: 401, headers: cacheHeaders() }) };
  }
  try {
    const decoded = await getAdminApp().auth().verifyIdToken(token);
    return { uid: decoded.uid };
  } catch (e) {
    const msg = (e as Error).message || "Invalid token";
    return { error: NextResponse.json({ error: msg }, { status: 401, headers: cacheHeaders() }) };
  }
}

async function userHasAccess(uid: string, locationId: string): Promise<boolean> {
  try {
    const locUserSnap = await db().collection("locations").doc(locationId).collection("users").doc(uid).get();
    if (locUserSnap.exists) return true;

    const userSnap = await db().collection("users").doc(uid).get();
    const userData = userSnap.data() || {};
    if ((userData.locationId as string) === locationId) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function parseCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const uid = auth.uid as string;

  const locationId = extractLocationId(req);
  if (!locationId) {
    return NextResponse.json({ error: "Missing locationId" }, { status: 400, headers: cacheHeaders() });
  }

  if (!(await userHasAccess(uid, locationId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: cacheHeaders() });
  }

  const locSnap = await db().collection("locations").doc(locationId).get();
  if (!locSnap.exists) {
    return NextResponse.json({ error: "Location not found" }, { status: 404, headers: cacheHeaders() });
  }

  const data = (locSnap.data() || {}) as Record<string, unknown>;
  const allTime = parseCount(data.allTimeLocationSubmisisons);
  const active = parseCount(data.activeLocationSubmisisons);

  return NextResponse.json(
    {
      allTimeLocationSubmisisons: allTime,
      activeLocationSubmisisons: active,
    },
    { status: 200, headers: cacheHeaders() },
  );
}
