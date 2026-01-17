import { NextResponse } from "next/server";
import { FieldValue, type DocumentData, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { db } from "@/lib/firebaseAdmin";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";
import { ghlRequest } from "@/lib/ghlClient";
import { cleanupSubmissionsAndMarkers } from "@/lib/submissionCleanup";
import { enqueueReconcileTask, resolveTaskBaseUrlFromEnv } from "@/lib/reconcileTasks";

export const runtime = "nodejs";

const RECONCILE_GROUPS_COLLECTION = "ghl_reconcile_groups";

type ReconcileRequest = {
  locationId?: string;
  groupId?: string;
  attempt?: unknown;
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

function collectContactIdsFromSubmissions(
  submissions: Array<QueryDocumentSnapshot<DocumentData>>,
): string[] {
  const ids = new Set<string>();
  for (const docSnap of submissions) {
    const data = docSnap.data() as Record<string, unknown>;
    const ghl = (data as { ghl?: Record<string, unknown> }).ghl;
    const list = Array.isArray(ghl?.contactIds) ? ghl.contactIds : [];
    for (const entry of list) {
      const id = readString(entry);
      if (id) ids.add(id);
    }
    const primary = readString(ghl?.contactId);
    if (primary) ids.add(primary);
    const flat = readString(data.contactId);
    if (flat) ids.add(flat);
  }
  return Array.from(ids);
}

async function fetchContactCountByContactIds(params: {
  accessToken: string;
  contactIds: string[];
}): Promise<number> {
  let total = 0;
  for (const contactId of params.contactIds) {
    const result = await ghlRequest<Record<string, unknown>>(
      `/contacts/${encodeURIComponent(contactId)}`,
      {
        accessToken: params.accessToken,
        method: "GET",
      },
    );
    if (result.ok) {
      total += 1;
      continue;
    }
    if (result.status === 404 || isMissingContact(result.status, result.text)) continue;
    throw new Error(`GHL contact fetch failed ${result.status}: ${result.text || result.status}`);
  }
  return total;
}

function isMissingContact(status: number, text: string): boolean {
  if (status !== 400) return false;
  const lower = text.toLowerCase();
  if (lower.includes("contact not found")) return true;
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed?.message === "string" && parsed.message.toLowerCase().includes("contact not found")) {
      return true;
    }
  } catch {
    // ignore parse failures; handled by string check above
  }
  return false;
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

  const contactIds = collectContactIdsFromSubmissions(submissionsSnap.docs);
  const accessToken = await getValidAccessTokenForLocation(locationId);
  let contactCount: number;
  if (contactIds.length === 0) {
    let fallbackCount = 0;
    for (const docSnap of submissionsSnap.docs) {
      const data = docSnap.data() as Record<string, unknown>;
      const storedCount = readNumber(data.numberOfGhlContactsCreated);
      if (storedCount !== null) fallbackCount = Math.max(fallbackCount, storedCount);
    }
    contactCount = fallbackCount;
    console.warn("[reconcile] no stored contact ids; using existing count", {
      locationId,
      groupId,
      count: contactCount,
    });
  } else {
    contactCount = await fetchContactCountByContactIds({ accessToken, contactIds });
  }

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
    Math.floor(readNumber(process.env.GHL_RECONCILE_MAX_ATTEMPTS) ?? 6),
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
        delaySeconds: 30,
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
