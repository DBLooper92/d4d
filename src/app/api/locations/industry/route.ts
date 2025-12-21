import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { db, getAdminApp } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

type IndustryPayload = {
  locationId?: string;
  industryChosen?: unknown;
  quickNotes?: unknown;
  idToken?: string;
};

function cacheHeaders() {
  return { "Cache-Control": "no-store" };
}

function extractLocationId(req: Request, body?: IndustryPayload): string {
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

  if (body?.locationId && typeof body.locationId === "string" && body.locationId.trim()) {
    return body.locationId.trim();
  }

  return "";
}

function extractIdToken(req: Request, body?: IndustryPayload): string | null {
  const authz = req.headers.get("authorization") || "";
  const bearer = authz.match(/Bearer\s+(.+)/i);
  if (bearer?.[1]) return bearer[1].trim();

  const headerToken = req.headers.get("x-id-token");
  if (headerToken && headerToken.trim()) return headerToken.trim();

  try {
    const url = new URL(req.url);
    const qp = url.searchParams.get("idToken") || url.searchParams.get("id_token");
    if (qp && qp.trim()) return qp.trim();
  } catch {
    /* ignore */
  }

  if (body?.idToken && typeof body.idToken === "string" && body.idToken.trim()) {
    return body.idToken.trim();
  }

  return null;
}

async function requireAuth(req: Request, body?: IndustryPayload) {
  const token = extractIdToken(req, body);
  if (!token) {
    return { error: NextResponse.json({ error: "Missing auth token" }, { status: 401, headers: cacheHeaders() }) };
  }
  try {
    const decoded = await getAdminApp().auth().verifyIdToken(token);
    return { uid: decoded.uid as string };
  } catch (e) {
    const msg = (e as Error).message || "Invalid token";
    return { error: NextResponse.json({ error: msg }, { status: 401, headers: cacheHeaders() }) };
  }
}

async function requireLocationAdmin(uid: string, locationId: string) {
  const locRef = db().collection("locations").doc(locationId);
  const [locSnap, locUserSnap] = await Promise.all([locRef.get(), locRef.collection("users").doc(uid).get()]);

  if (!locUserSnap.exists) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403, headers: cacheHeaders() }) };
  }

  const locData = (locSnap.data() || {}) as { adminUid?: unknown; adminGhlUserId?: unknown };
  const locUser = (locUserSnap.data() || {}) as Record<string, unknown>;
  const adminUid =
    typeof locData.adminUid === "string" && locData.adminUid.trim() ? (locData.adminUid as string).trim() : null;
  const adminGhlUserId =
    typeof locData.adminGhlUserId === "string" && locData.adminGhlUserId.trim()
      ? (locData.adminGhlUserId as string).trim()
      : null;

  const isAdmin =
    Boolean((locUser as { isAdmin?: boolean }).isAdmin) ||
    (typeof (locUser as { role?: string }).role === "string" &&
      ((locUser as { role?: string }).role as string).trim().toLowerCase() === "admin");

  const rawGhlUserId =
    typeof (locUser as { ghlUserId?: unknown }).ghlUserId === "string"
      ? ((locUser as { ghlUserId?: string }).ghlUserId as string)
      : typeof (locUser as { ghl?: { userId?: unknown } }).ghl?.userId === "string"
        ? ((locUser as { ghl?: { userId?: string } }).ghl?.userId as string)
        : "";
  const ghlUserId = rawGhlUserId.trim();

  if (adminUid) {
    if (adminUid !== uid) {
      return { error: NextResponse.json({ error: "Forbidden" }, { status: 403, headers: cacheHeaders() }) };
    }
    return { ok: true, adminGhlUserId: adminGhlUserId ?? null };
  }

  if (adminGhlUserId) {
    if (!ghlUserId || adminGhlUserId !== ghlUserId) {
      return { error: NextResponse.json({ error: "Forbidden" }, { status: 403, headers: cacheHeaders() }) };
    }
    return { ok: true, adminGhlUserId };
  }

  if (!isAdmin) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403, headers: cacheHeaders() }) };
  }

  return { ok: true, adminGhlUserId: adminGhlUserId ?? null };
}

function cleanNotes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const notes: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().slice(0, 120);
    if (trimmed) notes.push(trimmed);
    if (notes.length >= 5) break;
  }
  return notes;
}

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const uid = auth.uid as string;

  const locationId = extractLocationId(req);
  if (!locationId) {
    return NextResponse.json({ error: "Missing locationId" }, { status: 400, headers: cacheHeaders() });
  }

  const adminCheck = await requireLocationAdmin(uid, locationId);
  if ("error" in adminCheck) return adminCheck.error;

  const snap = await db().collection("locations").doc(locationId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Location not found" }, { status: 404, headers: cacheHeaders() });
  }

  const data = (snap.data() || {}) as { industryChosen?: unknown; industryQuickNotes?: unknown };
  const industryChosen = typeof data.industryChosen === "string" ? data.industryChosen.trim() : "";
  const quickNotes = cleanNotes(data.industryQuickNotes);

  return NextResponse.json(
    { industryChosen: industryChosen || null, quickNotes },
    { status: 200, headers: cacheHeaders() },
  );
}

export async function POST(req: Request) {
  let body: IndustryPayload = {};
  try {
    body = (await req.json()) as IndustryPayload;
  } catch {
    /* ignore */
  }

  const auth = await requireAuth(req, body);
  if ("error" in auth) return auth.error;
  const uid = auth.uid as string;

  const locationId = extractLocationId(req, body);
  if (!locationId) {
    return NextResponse.json({ error: "Missing locationId" }, { status: 400, headers: cacheHeaders() });
  }

  const adminCheck = await requireLocationAdmin(uid, locationId);
  if ("error" in adminCheck) return adminCheck.error;

  const industryChosen =
    typeof body.industryChosen === "string" && body.industryChosen.trim() ? body.industryChosen.trim() : "";
  if (!industryChosen) {
    return NextResponse.json({ error: "Missing industryChosen" }, { status: 400, headers: cacheHeaders() });
  }

  const quickNotes = cleanNotes(body.quickNotes);
  if (industryChosen.toLowerCase() === "other" && quickNotes.length === 0) {
    return NextResponse.json(
      { error: "Provide at least one quick note for Other" },
      { status: 400, headers: cacheHeaders() },
    );
  }

  try {
    await db()
      .collection("locations")
      .doc(locationId)
      .set(
        {
          industryChosen,
          industryQuickNotes: quickNotes,
          industryUpdatedAt: FieldValue.serverTimestamp(),
          industryUpdatedBy: uid,
        },
        { merge: true },
      );

    return NextResponse.json(
      {
        industryChosen,
        quickNotes,
      },
      { status: 200, headers: cacheHeaders() },
    );
  } catch (e) {
    const msg = (e as Error).message || "Failed to save industry";
    return NextResponse.json({ error: msg }, { status: 500, headers: cacheHeaders() });
  }
}
