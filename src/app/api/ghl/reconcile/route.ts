import { NextResponse } from "next/server";
import { FieldValue, type DocumentData, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { db } from "@/lib/firebaseAdmin";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";
import { ghlFetch } from "@/lib/ghlClient";
import { cleanupSubmissionsAndMarkers } from "@/lib/submissionCleanup";
import { enqueueReconcileTask, resolveTaskBaseUrlFromEnv } from "@/lib/reconcileTasks";

export const runtime = "nodejs";

const CONTACT_GROUP_FIELD = "d4d_contact_group_id";
const CONTACTS_PAGE_LIMIT = 100;
const MAX_CONTACT_PAGES = 50;
const RECONCILE_GROUPS_COLLECTION = "ghl_reconcile_groups";

type ReconcileRequest = {
  locationId?: string;
  groupId?: string;
  attempt?: unknown;
};

type GhlContactsResponse = {
  contacts?: Array<{ id?: string }>;
  meta?: Record<string, unknown>;
  pagination?: Record<string, unknown>;
  total?: unknown;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readAttempt(value: unknown): number {
  const parsed = readNumber(value);
  if (parsed === null) return 0;
  return Math.max(0, Math.floor(parsed));
}

function readTotalCount(data: GhlContactsResponse): number | null {
  const candidates: unknown[] = [];
  if (data.meta) {
    candidates.push(data.meta.total, data.meta.totalCount, data.meta.count);
  }
  if (data.pagination) {
    candidates.push(data.pagination.total, data.pagination.totalCount, data.pagination.count);
  }
  candidates.push(data.total);
  for (const value of candidates) {
    const parsed = readNumber(value);
    if (parsed !== null && parsed >= 0) return parsed;
  }
  return null;
}

function readNextPage(data: GhlContactsResponse): number | null {
  const candidates: unknown[] = [];
  if (data.meta) {
    candidates.push(data.meta.nextPage, data.meta.next_page, data.meta.page);
  }
  if (data.pagination) {
    candidates.push(data.pagination.nextPage, data.pagination.next_page, data.pagination.page);
  }
  for (const value of candidates) {
    const parsed = readNumber(value);
    if (parsed !== null && parsed > 0) return Math.floor(parsed);
  }
  return null;
}

async function fetchContactCount(params: {
  accessToken: string;
  locationId: string;
  groupId: string;
}): Promise<number> {
  let total = 0;
  let page = 1;

  for (let guard = 0; guard < MAX_CONTACT_PAGES; guard += 1) {
    const query: Record<string, string | number | boolean | undefined> = {
      locationId: params.locationId,
      limit: CONTACTS_PAGE_LIMIT,
      page,
    };
    query[`customField[${CONTACT_GROUP_FIELD}]`] = params.groupId;

    const data = await ghlFetch<GhlContactsResponse>("/contacts/", {
      accessToken: params.accessToken,
      query,
    });
    const totalCount = readTotalCount(data);
    if (totalCount !== null) return totalCount;

    const contacts = Array.isArray(data.contacts) ? data.contacts : [];
    total += contacts.length;
    if (contacts.length < CONTACTS_PAGE_LIMIT) break;

    const nextPage = readNextPage(data);
    if (nextPage && nextPage > page) {
      page = nextPage;
    } else {
      page += 1;
    }
  }

  return total;
}

export async function POST(req: Request) {
  const requiredToken = process.env.GHL_RECONCILE_TOKEN;
  if (requiredToken && req.headers.get("x-reconcile-token") !== requiredToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: ReconcileRequest;
  try {
    payload = (await req.json()) as ReconcileRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const locationId = readString(payload.locationId);
  const groupId = readString(payload.groupId);

  if (!locationId || !groupId) {
    return NextResponse.json({ error: "Missing locationId or groupId" }, { status: 400 });
  }

  const submissionsSnap = await db()
    .collection("locations")
    .doc(locationId)
    .collection("submissions")
    .where("skiptraceData.groupId", "==", groupId)
    .get();

  if (submissionsSnap.empty) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no submissions" }, { status: 200 });
  }

  const requestedAttempt = readAttempt(payload.attempt);
  const groupRef = db()
    .collection("locations")
    .doc(locationId)
    .collection(RECONCILE_GROUPS_COLLECTION)
    .doc(groupId);
  const groupSnap = await groupRef.get();
  const groupData = groupSnap.exists ? (groupSnap.data() as Record<string, unknown>) : null;
  const storedAttempt = readAttempt(groupData?.reconcileAttempts);
  const currentAttempt = Math.max(requestedAttempt, storedAttempt);

  const accessToken = await getValidAccessTokenForLocation(locationId);
  const contactCount = await fetchContactCount({ accessToken, locationId, groupId });

  console.info("[reconcile] group count", {
    locationId,
    groupId,
    attempt: currentAttempt,
    count: contactCount,
  });

  if (contactCount === 0) {
    const cleanupResult = await cleanupSubmissionsAndMarkers({
      locationId,
      submissions: submissionsSnap.docs as Array<QueryDocumentSnapshot<DocumentData>>,
    });
    console.info("[reconcile] deleted submissions", {
      locationId,
      groupId,
      submissionsDeleted: cleanupResult.submissionsDeleted,
      markersDeleted: cleanupResult.markersDeleted,
      usersUpdated: cleanupResult.usersUpdated,
      locationUpdated: cleanupResult.locationUpdated,
      storageDeleted: cleanupResult.storageDeleted,
    });
    try {
      await groupRef.delete();
    } catch (err) {
      console.warn("[reconcile] group delete failed", { locationId, groupId, err: String(err) });
    }
    return NextResponse.json({ ok: true, deleted: true, count: 0 }, { status: 200 });
  }

  const maxAttempts = Math.max(
    1,
    Math.floor(readNumber(process.env.GHL_RECONCILE_MAX_ATTEMPTS) ?? 2),
  );
  const shouldRequeue = contactCount > 0 && currentAttempt < maxAttempts - 1;
  let requeueQueued = false;
  let requeueDeduped = false;
  let missingBaseUrl = false;
  if (shouldRequeue) {
    const baseUrl = resolveTaskBaseUrlFromEnv();
    if (!baseUrl) {
      missingBaseUrl = true;
      console.error("[reconcile] missing GHL_TASK_BASE_URL; cannot requeue", {
        locationId,
        groupId,
        attempt: currentAttempt + 1,
      });
    } else {
      const result = await enqueueReconcileTask({
        locationId,
        groupId,
        baseUrl,
        attempt: currentAttempt + 1,
        delaySeconds: 120,
      });
      requeueQueued = result.queued;
      requeueDeduped = result.deduped;
      console.info("[reconcile] requeue", {
        locationId,
        groupId,
        attempt: currentAttempt + 1,
        queued: requeueQueued,
        deduped: requeueDeduped,
        taskName: result.taskName || null,
      });
    }
  }

  let batch = db().batch();
  let opCount = 0;
  for (const docSnap of submissionsSnap.docs) {
    batch.set(
      docSnap.ref,
      {
        numberOfGhlContactsCreated: contactCount,
        updatedAt: FieldValue.serverTimestamp(),
        "ghl.reconcilePending": shouldRequeue,
        "ghl.lastReconciledAt": FieldValue.serverTimestamp(),
        ...(shouldRequeue ? { "ghl.reconcileRequestedAt": FieldValue.serverTimestamp() } : {}),
      },
      { merge: true },
    );
    opCount += 1;
    if (opCount >= 450) {
      await batch.commit();
      batch = db().batch();
      opCount = 0;
    }
  }
  if (opCount > 0) {
    await batch.commit();
  }

  await groupRef.set(
    {
      groupId,
      reconcilePending: shouldRequeue,
      reconcileRequestedAt: shouldRequeue ? FieldValue.serverTimestamp() : FieldValue.delete(),
      reconcileAttempts: currentAttempt,
      lastReconciledAt: FieldValue.serverTimestamp(),
      lastCount: contactCount,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  if (missingBaseUrl) {
    return NextResponse.json({ error: "Missing GHL_TASK_BASE_URL" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, deleted: false, count: contactCount }, { status: 200 });
}
