// src/app/api/locations/skiptrace/route.ts
import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db, getAdminApp } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

type SkiptracePayload = {
  locationId?: string;
  skiptraceEnabled?: unknown;
  skipTraceRefreshAt?: unknown;
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

function buildNextMonthRefreshDate(base: Date): Date {
  const year = base.getFullYear();
  const month = base.getMonth();
  const day = base.getDate();
  const nextMonthIndex = month + 1;
  const targetYear = year + Math.floor(nextMonthIndex / 12);
  const targetMonth = nextMonthIndex % 12;
  const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const safeDay = Math.min(day, daysInTargetMonth);
  return new Date(targetYear, targetMonth, safeDay, 0, 1, 0, 0);
}

function extractClientRefreshAt(body?: SkiptracePayload): Date | null {
  const raw = body?.skipTraceRefreshAt;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof raw === "string" && raw.trim()) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
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
    const locRef = db().collection("locations").doc(locationId);
    const updates = {
      skiptraceEnabled: enabled,
      skiptraceUpdatedAt: FieldValue.serverTimestamp(),
      skiptraceUpdatedBy: uid,
    };

    if (!enabled) {
      await locRef.set(updates, { merge: true });
    } else {
      const clientRefreshAt = extractClientRefreshAt(body);
      await db().runTransaction(async (tx) => {
        const snap = await tx.get(locRef);
        const payload: Record<string, unknown> = { ...updates };
        const available = snap.exists ? snap.get("skipTracesAvailable") : undefined;
        const refresh = snap.exists ? snap.get("skipTraceRefresh") : undefined;
        if (typeof available === "undefined") {
          payload.skipTracesAvailable = 150;
        }
        if (typeof refresh === "undefined") {
          const refreshDate = clientRefreshAt ?? buildNextMonthRefreshDate(new Date());
          payload.skipTraceRefresh = Timestamp.fromDate(refreshDate);
        }
        tx.set(locRef, payload, { merge: true });
      });
    }

    return NextResponse.json({ skiptraceEnabled: enabled }, { status: 200, headers: cacheHeaders() });
  } catch (e) {
    const msg = (e as Error).message || "Failed to update";
    return NextResponse.json({ error: msg }, { status: 500, headers: cacheHeaders() });
  }
}
