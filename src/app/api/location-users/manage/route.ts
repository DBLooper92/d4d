// src/app/api/location-users/manage/route.ts
import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db, getAdminApp } from "@/lib/firebaseAdmin";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";
import { ghlFetch } from "@/lib/ghlClient";

export const runtime = "nodejs";

const ACTIVE_LIMIT = 5; // non-admin drivers

type ManageUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

type ManageResponse = {
  users: Array<
    ManageUser & {
      active: boolean;
      isAdmin: boolean;
      invited: boolean;
      inviteStatus?: string;
      invitedAt?: string | null;
      firebaseUid?: string | null;
      accepted: boolean;
    }
  >;
  activeLimit: number;
  activeCount: number; // excludes admin
  adminGhlUserId: string | null;
};

type ToggleBody = {
  locationId?: string;
  ghlUserId?: string;
  active?: boolean;
};

type InviteMeta = {
  status?: string | null;
  invitedAt?: number | null;
  lastSentAt?: number | null;
  invitedBy?: string | null;
  firebaseUid?: string | null;
  acceptedAt?: number | null;
};

function cacheHeaders() {
  return { "Cache-Control": "no-store" };
}

function extractIdToken(req: Request, body?: ToggleBody): string | null {
  const authz = req.headers.get("authorization") || "";
  const bearer = authz.match(/Bearer\\s+(.+)/i);
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

  if (body && typeof (body as Record<string, unknown>).idToken === "string") {
    const bodyToken = (body as Record<string, unknown>).idToken as string;
    if (bodyToken.trim()) return bodyToken.trim();
  }

  return null;
}

function extractLocationId(req: Request, body?: ToggleBody): string {
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
  if (body?.locationId && typeof body.locationId === "string") {
    return body.locationId.trim();
  }
  return "";
}

async function requireAuth(req: Request) {
  let body: ToggleBody | undefined;
  try {
    body = (await req.clone().json()) as ToggleBody;
  } catch {
    /* ignore */
  }

  const token = extractIdToken(req, body);
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

async function requireLocationAdmin(uid: string, locationId: string) {
  const ref = db().collection("locations").doc(locationId).collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403, headers: cacheHeaders() }) };
  const data = snap.data() || {};
  const isAdmin = Boolean((data as { isAdmin?: boolean; role?: string }).isAdmin) || (data as { role?: string }).role === "admin";
  if (!isAdmin) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403, headers: cacheHeaders() }) };
  }
  const ghlUserId =
    (data as { ghlUserId?: string }).ghlUserId ||
    ((data as { ghl?: { userId?: string } }).ghl?.userId ?? null);
  return { locationUser: data, adminGhlUserId: ghlUserId ? String(ghlUserId) : null };
}

async function fetchGhlUsers(locationId: string): Promise<ManageUser[]> {
  const accessToken = await getValidAccessTokenForLocation(locationId);
  type GhlUsersResponse =
    | { users?: Array<{ id: string; name?: string; email?: string; role?: string }> }
    | { data?: { users?: Array<{ id: string; name?: string; email?: string; role?: string }> } };
  const json = await ghlFetch<GhlUsersResponse>("/users/", {
    accessToken,
    query: { locationId },
  });
  const users =
    (json as { users?: ManageUser[] }).users ??
    (json as { data?: { users?: ManageUser[] } }).data?.users ??
    [];
  return Array.isArray(users) ? users : [];
}

type LocUserRecord = { uid: string; isAdmin: boolean; ghlUserId: string | null };

async function loadLocationUsers(locationId: string): Promise<Record<string, LocUserRecord>> {
  const snap = await db().collection("locations").doc(locationId).collection("users").limit(500).get();
  const map: Record<string, LocUserRecord> = {};
  snap.forEach((doc) => {
    const data = (doc.data() || {}) as Record<string, unknown>;
    let ghlUserId: string | null = null;
    if (typeof data.ghlUserId === "string" && data.ghlUserId.trim()) {
      ghlUserId = data.ghlUserId.trim();
    } else if (data.ghl && typeof (data.ghl as { userId?: string }).userId === "string") {
      const val = (data.ghl as { userId?: string }).userId;
      if (val && val.trim()) ghlUserId = val.trim();
    }
    if (ghlUserId) {
      map[ghlUserId] = {
        uid: doc.id,
        isAdmin: Boolean((data as { isAdmin?: boolean; role?: string }).isAdmin) || (data as { role?: string }).role === "admin",
        ghlUserId,
      };
    }
  });
  return map;
}

async function syncActiveToUserDocs(locationId: string, targetGhlUserId: string, active: boolean) {
  // Best-effort: align active flag on any known user docs under this location (and root users)
  const locUsersCol = db().collection("locations").doc(locationId).collection("users");
  const matches = await Promise.all([
    locUsersCol.where("ghl.userId", "==", targetGhlUserId).limit(20).get(),
    locUsersCol.where("ghlUserId", "==", targetGhlUserId).limit(20).get(),
  ]);
  const seen = new Set<string>();
  const locDocs = matches
    .flatMap((m) => m.docs)
    .filter((d) => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
  const writes: Promise<unknown>[] = [];
  for (const d of locDocs) {
    writes.push(locUsersCol.doc(d.id).set({ active }, { merge: true }));
    writes.push(db().collection("users").doc(d.id).set({ active }, { merge: true }));
  }
  if (writes.length) {
    await Promise.allSettled(writes);
  }
}

function computeActiveCount(map: Record<string, boolean>, adminGhlUserId: string | null): number {
  return Object.entries(map).filter(([id, val]) => id !== adminGhlUserId && Boolean(val)).length;
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
  const adminGhlUserId = adminCheck.adminGhlUserId;

  const locSnap = await db().collection("locations").doc(locationId).get();
  const locData = (locSnap.data() || {}) as { activeUsers?: Record<string, boolean>; invites?: Record<string, InviteMeta> };
  const activeUsers = { ...(locData.activeUsers || {}) };
  const invites = { ...(locData.invites || {}) } as Record<string, InviteMeta>;
  const locUsers = await loadLocationUsers(locationId);

  // Enforce admin always active if we can identify them
  if (adminGhlUserId && activeUsers[adminGhlUserId] !== true) {
    activeUsers[adminGhlUserId] = true;
    const updates = [
      db()
        .collection("locations")
        .doc(locationId)
        .set(
          {
            activeUsers,
            activeUpdatedAt: FieldValue.serverTimestamp(),
            activeUpdatedBy: uid,
          },
          { merge: true },
        ),
      db()
        .collection("locations")
        .doc(locationId)
        .collection("users")
        .doc(uid)
        .set({ active: true }, { merge: true }),
      syncActiveToUserDocs(locationId, adminGhlUserId, true),
    ];
    await Promise.allSettled(updates);
  }

  let users: ManageUser[] = [];
  try {
    users = await fetchGhlUsers(locationId);
  } catch (e) {
    const msg = (e as Error).message || "Failed to load users";
    return NextResponse.json({ error: msg }, { status: 502, headers: cacheHeaders() });
  }

  let changed = false;
  const mapped: ManageResponse["users"] = users.map((u) => {
    const isAdmin = !!adminGhlUserId && u.id === adminGhlUserId;
    const locUser = locUsers[u.id];
    const firebaseUid = locUser?.uid ?? null;
    const accepted = Boolean(firebaseUid);
    const invitedMeta = invites[u.id] || null;
    const activeBefore = isAdmin ? true : Boolean(activeUsers[u.id]);

    // If not accepted, force inactive
    if (!accepted && activeBefore) {
      activeUsers[u.id] = false;
      changed = true;
    }

    let active = isAdmin ? true : Boolean(activeUsers[u.id]);

    // Auto-activate accepted users if slots available
    if (accepted && !isAdmin && !active) {
      const currentCount = computeActiveCount(activeUsers, adminGhlUserId);
      if (currentCount < ACTIVE_LIMIT) {
        activeUsers[u.id] = true;
        active = true;
        changed = true;
      }
    }

    const invited = Boolean(invitedMeta);
    const inviteStatus =
      invitedMeta?.status ||
      (invited ? (invitedMeta?.firebaseUid ? "accepted" : "invited") : undefined);
    let invitedAt: string | null = null;
    const invitedVal = invitedMeta?.invitedAt;
    if (typeof invitedVal === "number") invitedAt = new Date(invitedVal).toISOString();
    else if (invitedVal instanceof Timestamp) invitedAt = new Date(invitedVal.toMillis()).toISOString();

    // If we have acceptance but no invite meta, mark it
    if (accepted && invitedMeta && !invitedMeta.firebaseUid) {
      invites[u.id] = { ...invitedMeta, firebaseUid, acceptedAt: Date.now(), status: "accepted" };
      changed = true;
    }

    return { ...u, active, isAdmin, invited, inviteStatus, invitedAt, firebaseUid, accepted };
  });

  const activeCount = computeActiveCount(activeUsers, adminGhlUserId);

  if (changed) {
    const updates: Record<string, unknown> = {
      activeUsers,
      invites,
      activeUpdatedAt: FieldValue.serverTimestamp(),
      activeUpdatedBy: uid,
    };
    await db().collection("locations").doc(locationId).set(updates, { merge: true });
  }

  return NextResponse.json(
    {
      users: mapped,
      activeLimit: ACTIVE_LIMIT,
      activeCount,
      adminGhlUserId: adminGhlUserId || null,
    },
    { status: 200, headers: cacheHeaders() },
  );
}

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const uid = auth.uid as string;

  let body: ToggleBody = {};
  try {
    body = (await req.json()) as ToggleBody;
  } catch {
    /* noop */
  }

  const locationId = extractLocationId(req, body);
  if (!locationId) {
    return NextResponse.json({ error: "Missing locationId" }, { status: 400, headers: cacheHeaders() });
  }

  const adminCheck = await requireLocationAdmin(uid, locationId);
  if ("error" in adminCheck) return adminCheck.error;
  const adminGhlUserId = adminCheck.adminGhlUserId;
  const locUsers = await loadLocationUsers(locationId);

  const targetGhlUserId = typeof body.ghlUserId === "string" ? body.ghlUserId.trim() : "";
  const nextActive = body.active === true;
  if (!targetGhlUserId) {
    return NextResponse.json({ error: "Missing ghlUserId" }, { status: 400, headers: cacheHeaders() });
  }
  if (adminGhlUserId && targetGhlUserId === adminGhlUserId && !nextActive) {
    return NextResponse.json({ error: "Admin must remain active" }, { status: 400, headers: cacheHeaders() });
  }
  const locUser = locUsers[targetGhlUserId];
  const accepted = Boolean(locUser?.uid);
  if (!accepted && !adminGhlUserId) {
    return NextResponse.json({ error: "INVITE_PENDING" }, { status: 409, headers: cacheHeaders() });
  }
  if (!accepted && targetGhlUserId !== adminGhlUserId) {
    return NextResponse.json({ error: "INVITE_PENDING" }, { status: 409, headers: cacheHeaders() });
  }

  const locRef = db().collection("locations").doc(locationId);
  const locSnap = await locRef.get();
  const locData = (locSnap.data() || {}) as { activeUsers?: Record<string, boolean> };
  const activeUsers = { ...(locData.activeUsers || {}) };

  if (adminGhlUserId && activeUsers[adminGhlUserId] !== true) {
    activeUsers[adminGhlUserId] = true;
  }

  const currentActiveCount = computeActiveCount(activeUsers, adminGhlUserId);
  const alreadyActive = Boolean(activeUsers[targetGhlUserId]);

  if (nextActive && !alreadyActive) {
    if (targetGhlUserId === adminGhlUserId) {
      // always allowed
    } else if (currentActiveCount >= ACTIVE_LIMIT) {
      return NextResponse.json(
        { error: "ACTIVE_LIMIT_REACHED", activeLimit: ACTIVE_LIMIT },
        { status: 409, headers: cacheHeaders() },
      );
    }
  }

  activeUsers[targetGhlUserId] = nextActive || targetGhlUserId === adminGhlUserId;

  await locRef.set(
    {
      activeUsers,
      activeUpdatedAt: FieldValue.serverTimestamp(),
      activeUpdatedBy: uid,
    },
    { merge: true },
  );

  try {
    await syncActiveToUserDocs(locationId, targetGhlUserId, activeUsers[targetGhlUserId]);
  } catch {
    /* best-effort */
  }

  const activeCount = computeActiveCount(activeUsers, adminGhlUserId);

  return NextResponse.json(
    {
      ok: true,
      activeUsers,
      activeCount,
      activeLimit: ACTIVE_LIMIT,
    },
    { status: 200, headers: cacheHeaders() },
  );
}
