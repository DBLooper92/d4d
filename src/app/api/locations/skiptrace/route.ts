// src/app/api/locations/skiptrace/route.ts
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { db, getAdminApp } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

type SkiptracePayload = {
  locationId?: string;
  skiptraceEnabled?: unknown;
};

function extractLocationId(req: Request, body?: SkiptracePayload): string {
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

  const loc =
    body?.locationId ||
    (typeof body?.locationId === "string" ? body.locationId : "") ||
    "";
  return typeof loc === "string" ? loc.trim() : "";
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
    return { error: NextResponse.json({ error: "Missing auth token" }, { status: 401 }) };
  }
  try {
    const decoded = await getAdminApp().auth().verifyIdToken(token);
    return { uid: decoded.uid };
  } catch (e) {
    const msg = (e as Error).message || "Invalid token";
    return { error: NextResponse.json({ error: msg }, { status: 401 }) };
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

function cacheHeaders() {
  return { "Cache-Control": "no-store" };
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

  const snap = await db().collection("locations").doc(locationId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Location not found" }, { status: 404, headers: cacheHeaders() });
  }

  const data = snap.data() || {};
  const enabled = Boolean(data.skiptraceEnabled);

  return NextResponse.json({ skiptraceEnabled: enabled }, { status: 200, headers: cacheHeaders() });
}

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const uid = auth.uid as string;

  let body: SkiptracePayload = {};
  try {
    body = (await req.json()) as SkiptracePayload;
  } catch {
    /* ignore */
  }

  const locationId = extractLocationId(req, body);
  if (!locationId) {
    return NextResponse.json({ error: "Missing locationId" }, { status: 400, headers: cacheHeaders() });
  }

  if (!(await userHasAccess(uid, locationId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: cacheHeaders() });
  }

  const enabled = body.skiptraceEnabled === true;
  try {
    await db()
      .collection("locations")
      .doc(locationId)
      .set(
        {
          skiptraceEnabled: enabled,
          skiptraceUpdatedAt: FieldValue.serverTimestamp(),
          skiptraceUpdatedBy: uid,
        },
        { merge: true },
      );

    return NextResponse.json({ skiptraceEnabled: enabled }, { status: 200, headers: cacheHeaders() });
  } catch (e) {
    const msg = (e as Error).message || "Failed to update";
    return NextResponse.json({ error: msg }, { status: 500, headers: cacheHeaders() });
  }
}
