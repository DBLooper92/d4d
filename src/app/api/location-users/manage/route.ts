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
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
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
  invitedAt?: number | Timestamp | null;
  lastSentAt?: number | Timestamp | null;
  invitedBy?: string | null;
  firebaseUid?: string | null;
  acceptedAt?: number | Timestamp | null;
};

function cacheHeaders() {
  return { "Cache-Control": "no-store" };
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function cleanPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length ? trimmed : null;
}

function pickDisplayName(data: {
  name?: unknown;
  fullName?: unknown;
  displayName?: unknown;
  email?: unknown;
  firstName?: unknown;
  lastName?: unknown;
}): string | null {
  const first = cleanString(data.firstName);
  const last = cleanString(data.lastName);
  const composed = [first, last].filter(Boolean).join(" ").trim();
  if (composed) return composed;

  const candidates: Array<string | null> = [
    cleanString(data.name),
    cleanString(data.fullName),
    cleanString(data.displayName),
  ];
  for (const c of candidates) {
    if (c) return c;
  }
  return cleanString(data.email);
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
  const data = snap.exists ? (snap.data() || {}) : {};
  const locIsAdmin = Boolean((data as { isAdmin?: boolean; role?: string }).isAdmin) || (data as { role?: string }).role === "admin";
  const locGhlUserId =
    (data as { ghlUserId?: string }).ghlUserId ||
    ((data as { ghl?: { userId?: string } }).ghl?.userId ?? null);

  if (locIsAdmin) {
    return { locationUser: data, adminGhlUserId: locGhlUserId ? String(locGhlUserId) : null };
  }

  // Fallback: treat root-level admin as a location admin so they can manage users even if the location doc is missing.
  const rootSnap = await db().collection("users").doc(uid).get();
  if (rootSnap.exists()) {
    const rootData = rootSnap.data() || {};
    const rootIsAdmin =
      Boolean((rootData as { isAdmin?: boolean; role?: string }).isAdmin) ||
      (rootData as { role?: string }).role === "admin";
    if (rootIsAdmin) {
      const rootGhlUserId =
        (rootData as { ghlUserId?: string }).ghlUserId ||
        ((rootData as { ghl?: { userId?: string } }).ghl?.userId ?? null) ||
        locGhlUserId;
      return { locationUser: rootData, adminGhlUserId: rootGhlUserId ? String(rootGhlUserId) : null };
    }
  }

  return { error: NextResponse.json({ error: "Forbidden" }, { status: 403, headers: cacheHeaders() }) };
}

async function fetchGhlUsers(locationId: string): Promise<ManageUser[]> {
  const accessToken = await getValidAccessTokenForLocation(locationId);
type GhlUsersResponse =
  | { users?: Array<{ id: string; name?: string; email?: string; role?: string; firstName?: string; lastName?: string }> }
  | { data?: { users?: Array<{ id: string; name?: string; email?: string; role?: string; firstName?: string; lastName?: string }> } };
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
    const rawGhlUserId =
      typeof data.ghlUserId === "string"
        ? data.ghlUserId
        : data.ghl && typeof (data.ghl as { userId?: unknown }).userId === "string"
          ? ((data.ghl as { userId?: string }).userId as string)
          : "";
    const ghlUserId = rawGhlUserId.trim();
    if (!ghlUserId) return;
    map[ghlUserId] = {
      uid: doc.id,
      isAdmin: Boolean((data as { isAdmin?: boolean; role?: string }).isAdmin) || (data as { role?: string }).role === "admin",
      ghlUserId,
    };
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
  const locData = (locSnap.data() || {}) as {
    activeUsers?: Record<string, boolean>;
    invites?: Record<string, InviteMeta>;
    userDirectory?: Record<
      string,
      { name?: string; email?: string; role?: string; firebaseUid?: string | null; phone?: string | null }
    >;
  };
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
    const displayName = pickDisplayName({ ...u });
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

    const phone =
      cleanPhone((u as { phone?: unknown }).phone) ||
      cleanPhone((u as { mobilePhone?: unknown }).mobilePhone) ||
      cleanPhone((u as { phoneNumber?: unknown }).phoneNumber) ||
      null;

    return {
      ...u,
      name: u.name ?? displayName ?? null,
      phone,
      active,
      isAdmin,
      invited,
      inviteStatus,
      invitedAt,
      firebaseUid,
      accepted,
    };
  });

  // Persist a directory of GHL users with display metadata for dashboard lookups.
  try {
    const existingDirectory = (locData.userDirectory || {}) as Record<
      string,
      { name?: string; email?: string; role?: string; firebaseUid?: string | null; phone?: string | null }
    >;
    const patch: Record<
      string,
      { name?: string; email?: string; role?: string; firebaseUid?: string | null; phone?: string | null }
    > = {};

    mapped.forEach((u) => {
      const userId = cleanString(u.id);
      if (!userId) return;
      const nextName = pickDisplayName(u);
      const nextEmail = cleanString(u.email);
      const nextRole = cleanString(u.role);
      const nextFirebaseUid = cleanString(u.firebaseUid);
      const nextPhone = cleanPhone(u.phone);
      const current = existingDirectory[userId] || {};
      const updated: {
        name?: string;
        email?: string;
        role?: string;
        firebaseUid?: string | null;
        phone?: string | null;
      } = { ...current };
      let dirty = false;

      if (nextName && nextName !== current.name) {
        updated.name = nextName;
        dirty = true;
      }
      if (nextEmail && nextEmail !== current.email) {
        updated.email = nextEmail;
        dirty = true;
      }
      if (nextRole && nextRole !== current.role) {
        updated.role = nextRole;
        dirty = true;
      }
      if (nextFirebaseUid && nextFirebaseUid !== current.firebaseUid) {
        updated.firebaseUid = nextFirebaseUid;
        dirty = true;
      }
      if (nextPhone && nextPhone !== current.phone) {
        updated.phone = nextPhone;
        dirty = true;
      }

      if (dirty) {
        patch[userId] = updated;
      }
    });

    if (Object.keys(patch).length) {
      const docRef = db().collection("locations").doc(locationId);
      const data: Record<string, unknown> = {};
      Object.entries(patch).forEach(([userId, entry]) => {
        data[`userDirectory.${userId}`] = entry;
      });
      await docRef.set(data, { merge: true });
    }
  } catch {
    /* non-fatal directory persistence */
  }

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
