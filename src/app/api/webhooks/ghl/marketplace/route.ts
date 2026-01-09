// src/app/api/webhooks/ghl/marketplace/route.ts
import { NextResponse } from "next/server";
import { db, getAdminApp } from "@/lib/firebaseAdmin";
import { FieldValue, type DocumentData, type DocumentReference, type QueryDocumentSnapshot, type WriteBatch } from "firebase-admin/firestore";
import { ensureLocationInstallRecord } from "@/lib/locationInstall";

export const runtime = "nodejs";

/**
 * -------- Incoming payload shapes we handle (lenient) ----------
 */
/** Type guards */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function hasKey<T extends string>(
  obj: Record<string, unknown>,
  key: T,
): obj is Record<T, unknown> & Record<string, unknown> {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Safe readers */
type Action = "install" | "uninstall" | null;

function parseAction(p: unknown): { action: Action; type: string; event: string } {
  if (!isObject(p)) return { action: null, type: "", event: "" };
  const rawType = hasKey(p, "type") && isString(p.type) ? p.type : "";
  const rawEvent = hasKey(p, "event") && isString(p.event) ? p.event : "";
  const t = rawType.toLowerCase();
  const e = rawEvent.toLowerCase();
  const isUninstall = t === "uninstall" || e === "appuninstall" || t.includes("uninstall") || e.includes("uninstall");
  const isInstall = !isUninstall && (t === "install" || e === "appinstall" || t.includes("install") || e.includes("install"));
  return { action: isInstall ? "install" : isUninstall ? "uninstall" : null, type: rawType, event: rawEvent };
}

function pickString(obj: unknown, key: string): string {
  if (!isObject(obj)) return "";
  const v = hasKey(obj, key) ? obj[key] : undefined;
  return isString(v) ? v.trim() : "";
}
function coerceString(value: unknown): string {
  return isString(value) ? value.trim() : "";
}
function parseCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
  }
  return null;
}
function readSubmissionContactIds(data: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const topLevel = coerceString((data as { contactId?: unknown }).contactId);
  if (topLevel) ids.add(topLevel);
  const ghl = (data as { ghl?: { contactId?: unknown; contactIds?: unknown } }).ghl;
  const nestedContactId = coerceString(ghl?.contactId);
  if (nestedContactId) ids.add(nestedContactId);
  if (Array.isArray(ghl?.contactIds)) {
    for (const value of ghl.contactIds) {
      const id = coerceString(value);
      if (id) ids.add(id);
    }
  }
  return Array.from(ids);
}
function readSubmissionContactCount(data: Record<string, unknown>, contactIds: string[]): number {
  const stored = parseCount((data as { numberOfGhlContactsCreated?: unknown }).numberOfGhlContactsCreated);
  if (stored !== null) return stored;
  return contactIds.length;
}
function pickNestedString(obj: unknown, path: string[]): string {
  let current: unknown = obj;
  for (const key of path) {
    if (!isObject(current) || !hasKey(current, key)) return "";
    current = current[key];
  }
  return isString(current) ? current.trim() : "";
}
function normalizeEventKey(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const BILLING_EVENT_KEYS = new Set(
  [
    "SaasPlanCreate",
    "InvoiceCreate",
    "InvoicePaid",
    "InvoicePartiallyPaid",
    "InvoiceVoid",
    "InvoiceDelete",
    "OrderStatusUpdate",
  ].map(normalizeEventKey),
);

function readEventName(payload: unknown): string {
  if (!isObject(payload)) return "";
  const candidates = ["type", "event", "eventType", "name"];
  for (const key of candidates) {
    const value = pickString(payload, key);
    if (value) return value;
  }
  return "";
}
function resolveStorageBucket(): string {
  const app = getAdminApp();
  const appBucket = (app.options as { storageBucket?: string }).storageBucket;
  if (appBucket && appBucket.trim().length > 0) return appBucket.trim();
  const envCandidates = ["FIREBASE_STORAGE_BUCKET", "FIREBASE_ADMIN_STORAGE_BUCKET", "GOOGLE_CLOUD_STORAGE_BUCKET"];
  for (const name of envCandidates) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return value.trim();
  }
  return "";
}
function decodeStoragePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function parseStorageUrl(url: string): { bucket: string; path: string } {
  if (!url) return { bucket: "", path: "" };
  if (url.startsWith("gs://")) {
    const withoutScheme = url.slice("gs://".length);
    const [bucket, ...rest] = withoutScheme.split("/");
    return { bucket: bucket || "", path: rest.join("/") };
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;
    if (host === "firebasestorage.googleapis.com") {
      const match = pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
      if (match) {
        return { bucket: match[1], path: decodeStoragePath(match[2]) };
      }
    }
    if (host === "storage.googleapis.com") {
      const altMatch = pathname.match(/^\/download\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/);
      if (altMatch) {
        return { bucket: altMatch[1], path: decodeStoragePath(altMatch[2]) };
      }
      const parts = pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const [bucket, ...rest] = parts;
        return { bucket, path: decodeStoragePath(rest.join("/")) };
      }
    }
  } catch {
    return { bucket: "", path: "" };
  }
  return { bucket: "", path: "" };
}
function collectStorageTargets(photo: unknown, fallbackBucket: string): Array<{ bucket: string; path: string }> {
  const targets: Array<{ bucket: string; path: string }> = [];
  const pushTarget = (bucket: string, path: string) => {
    const cleanBucket = bucket.trim();
    const cleanPath = path.trim().replace(/^\/+/, "");
    if (!cleanBucket || !cleanPath) return;
    targets.push({ bucket: cleanBucket, path: cleanPath });
  };

  if (isString(photo)) {
    if (photo.includes("://")) {
      const parsed = parseStorageUrl(photo);
      if (parsed.bucket && parsed.path) {
        pushTarget(parsed.bucket, parsed.path);
      }
    } else if (fallbackBucket) {
      pushTarget(fallbackBucket, photo);
    }
    return targets;
  }

  if (!isObject(photo)) return targets;

  const storagePath = pickString(photo, "storagePath");
  const downloadUrl = pickString(photo, "downloadUrl") || pickString(photo, "url");
  const bucketHint =
    pickString(photo, "bucket") ||
    pickString(photo, "storageBucket") ||
    fallbackBucket;

  if (downloadUrl) {
    const parsed = parseStorageUrl(downloadUrl);
    if (parsed.bucket && parsed.path) {
      pushTarget(parsed.bucket, parsed.path);
    }
  }

  if (storagePath && bucketHint) {
    pushTarget(bucketHint, storagePath);
  }

  return targets;
}
function readContactId(payload: unknown, eventKey: string, webhookId: string): { contactId: string; source: string | null } {
  const candidates: Array<{ path: string[]; source: string }> = [
    { path: ["contactId"], source: "contactId" },
    { path: ["contact_id"], source: "contact_id" },
    { path: ["contact", "id"], source: "contact.id" },
    { path: ["contact", "contactId"], source: "contact.contactId" },
    { path: ["contact", "contact_id"], source: "contact.contact_id" },
    { path: ["data", "contactId"], source: "data.contactId" },
    { path: ["data", "contact_id"], source: "data.contact_id" },
    { path: ["data", "contact", "id"], source: "data.contact.id" },
    { path: ["data", "contact", "contactId"], source: "data.contact.contactId" },
    { path: ["data", "contact", "contact_id"], source: "data.contact.contact_id" },
  ];

  if (eventKey.startsWith("contact")) {
    candidates.push(
      { path: ["id"], source: "id" },
      { path: ["data", "id"], source: "data.id" },
    );
  }

  for (const candidate of candidates) {
    const value = pickNestedString(payload, candidate.path);
    if (!value) continue;
    if ((candidate.source === "id" || candidate.source === "data.id") && value === webhookId) {
      continue;
    }
    return { contactId: value, source: candidate.source };
  }

  return { contactId: "", source: null };
}
async function cleanupContactSubmissions(params: {
  locationId: string;
  contactId: string;
}): Promise<{
  submissionsDeleted: number;
  submissionsDecremented: number;
  markersDeleted: number;
  usersUpdated: number;
  locationUpdated: boolean;
  storageDeleted: number;
}> {
  const firestore = db();
  const submissionsCol = firestore.collection("locations").doc(params.locationId).collection("submissions");
  const markersCol = firestore.collection("locations").doc(params.locationId).collection("markers");
  const usersCol = firestore.collection("locations").doc(params.locationId).collection("users");
  const locationRef = firestore.collection("locations").doc(params.locationId);

  const [nestedSnap, flatSnap, arraySnap] = await Promise.all([
    submissionsCol.where("ghl.contactId", "==", params.contactId).get(),
    submissionsCol.where("contactId", "==", params.contactId).get(),
    submissionsCol.where("ghl.contactIds", "array-contains", params.contactId).get(),
  ]);

  const submissionMap = new Map<string, QueryDocumentSnapshot<DocumentData>>();
  nestedSnap.docs.forEach((docSnap) => submissionMap.set(docSnap.id, docSnap));
  flatSnap.docs.forEach((docSnap) => submissionMap.set(docSnap.id, docSnap));
  arraySnap.docs.forEach((docSnap) => submissionMap.set(docSnap.id, docSnap));

  if (submissionMap.size === 0) {
    return {
      submissionsDeleted: 0,
      submissionsDecremented: 0,
      markersDeleted: 0,
      usersUpdated: 0,
      locationUpdated: false,
      storageDeleted: 0,
    };
  }

  const geohashes = new Set<string>();
  const userCounts = new Map<string, number>();
  const submissionRefs: DocumentReference[] = [];
  const decrementTargets: Array<{ ref: DocumentReference; nextCount: number }> = [];
  const storageTargets = new Map<string, { bucket: string; path: string }>();
  const fallbackBucket = resolveStorageBucket();

  for (const docSnap of submissionMap.values()) {
    const data = docSnap.data() as Record<string, unknown>;
    const contactIds = readSubmissionContactIds(data);
    const totalContacts = readSubmissionContactCount(data, contactIds);
    if (totalContacts >= 2) {
      decrementTargets.push({ ref: docSnap.ref, nextCount: Math.max(totalContacts - 1, 0) });
      continue;
    }

    submissionRefs.push(docSnap.ref);
    const geohash = coerceString(data.geohash);
    if (geohash) geohashes.add(geohash);

    const createdByUserId = coerceString(data.createdByUserId);
    if (createdByUserId) {
      userCounts.set(createdByUserId, (userCounts.get(createdByUserId) ?? 0) + 1);
    }

    const photoTargets = collectStorageTargets(data.photo, fallbackBucket);
    for (const target of photoTargets) {
      const key = `${target.bucket}/${target.path}`;
      if (!storageTargets.has(key)) storageTargets.set(key, target);
    }
  }

  if (storageTargets.size > 0) {
    const storage = getAdminApp().storage();
    for (const target of storageTargets.values()) {
      try {
        await storage.bucket(target.bucket).file(target.path).delete({ ignoreNotFound: true });
      } catch (err) {
        console.warn("[marketplace] storage delete failed", {
          bucket: target.bucket,
          path: target.path,
          err: String(err),
        });
      }
    }
  }

  let usersUpdated = 0;
  const userRefs = Array.from(userCounts.keys()).map((uid) => usersCol.doc(uid));
  const existingUserIds = new Set<string>();
  if (userRefs.length > 0) {
    const userSnaps = await firestore.getAll(...userRefs);
    userSnaps.forEach((snap) => {
      if (snap.exists) existingUserIds.add(snap.id);
    });
  }

  let locationUpdated = false;
  const locationSnap = await locationRef.get();
  const totalSubmissions = submissionRefs.length;

  const ops: Array<(batch: WriteBatch) => void> = [];
  let submissionsDecremented = 0;

  if (locationSnap.exists && totalSubmissions > 0) {
    ops.push((batch) =>
      batch.update(locationRef, {
        activeLocationSubmisisons: FieldValue.increment(-totalSubmissions),
      })
    );
    locationUpdated = true;
  }

  for (const [userId, count] of userCounts.entries()) {
    if (!existingUserIds.has(userId)) continue;
    const ref = usersCol.doc(userId);
    ops.push((batch) =>
      batch.update(ref, {
        activeUserSubmisisons: FieldValue.increment(-count),
      })
    );
    usersUpdated += 1;
  }

  for (const geohash of geohashes) {
    ops.push((batch) => batch.delete(markersCol.doc(geohash)));
  }

  for (const ref of submissionRefs) {
    ops.push((batch) => batch.delete(ref));
  }

  for (const target of decrementTargets) {
    ops.push((batch) =>
      batch.update(target.ref, {
        numberOfGhlContactsCreated: target.nextCount,
        updatedAt: FieldValue.serverTimestamp(),
      })
    );
    submissionsDecremented += 1;
  }

  const BATCH_LIMIT = 450;
  let batch = firestore.batch();
  let opCount = 0;
  for (const op of ops) {
    op(batch);
    opCount += 1;
    if (opCount >= BATCH_LIMIT) {
      await batch.commit();
      batch = firestore.batch();
      opCount = 0;
    }
  }
  if (opCount > 0) {
    await batch.commit();
  }

  return {
    submissionsDeleted: submissionRefs.length,
    submissionsDecremented,
    markersDeleted: geohashes.size,
    usersUpdated,
    locationUpdated,
    storageDeleted: storageTargets.size,
  };
}

function pickLogHeaders(headers: Headers): Record<string, string> {
  const interesting = [
    "x-gohighlevel-signature",
    "x-leadconnector-signature",
    "x-lc-signature",
    "x-forwarded-for",
    "x-cloud-trace-context",
    "x-request-id",
    "user-agent",
  ];
  const out: Record<string, string> = {};
  for (const name of interesting) {
    const value = headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

async function logBillingWebhookCapture(params: {
  eventName: string;
  eventKey: string;
  webhookId: string;
  companyId: string;
  locationId: string;
  planId: string;
  contactId: string;
  contactIdSource: string | null;
  rawBody: string;
  payload: unknown;
  headers: Record<string, string>;
}) {
  const col = db().collection("ghl_webhook_events");
  const docRef = params.webhookId ? col.doc(params.webhookId) : col.doc();
  const data: Record<string, unknown> = {
    source: "ghl_marketplace",
    eventName: params.eventName || "unknown",
    eventKey: params.eventKey,
    webhookId: params.webhookId || null,
    companyId: params.companyId || null,
    locationId: params.locationId || null,
    planId: params.planId || null,
    contactId: params.contactId || null,
    contactIdSource: params.contactIdSource || null,
    receivedAt: FieldValue.serverTimestamp(),
    rawBody: params.rawBody,
    rawLength: params.rawBody.length,
    payload: isObject(params.payload) ? params.payload : { value: params.payload },
  };
  if (Object.keys(params.headers).length) data.headers = params.headers;
  await docRef.set(data, { merge: true });
}

async function logRawWebhook(params: {
  eventName: string;
  eventKey: string;
  action: string | null;
  webhookId: string;
  companyId: string;
  locationId: string;
  planId: string;
  contactId: string;
  contactIdSource: string | null;
  rawBody: string;
  isBillingEvent: boolean;
  headers: Record<string, string>;
}) {
  const col = db().collection("ghl_webhook_raw");
  const docRef = params.webhookId ? col.doc(params.webhookId) : col.doc();
  const data: Record<string, unknown> = {
    source: "ghl_marketplace",
    eventName: params.eventName || "unknown",
    eventKey: params.eventKey,
    action: params.action,
    webhookId: params.webhookId || null,
    companyId: params.companyId || null,
    locationId: params.locationId || null,
    planId: params.planId || null,
    contactId: params.contactId || null,
    contactIdSource: params.contactIdSource || null,
    isBillingEvent: params.isBillingEvent,
    receivedAt: FieldValue.serverTimestamp(),
    rawBody: params.rawBody,
    rawLength: params.rawBody.length,
  };
  if (Object.keys(params.headers).length) data.headers = params.headers;
  await docRef.set(data, { merge: true });
}

export async function POST(req: Request) {
  const rawText = await req.text();
  let payloadUnknown: unknown;
  try {
    payloadUnknown = rawText ? (JSON.parse(rawText) as unknown) : {};
  } catch {
    console.info("[marketplace] webhook bad json", {
      rawLength: rawText.length,
      rawSample: rawText.slice(0, 200),
    });
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const { action, type, event } = parseAction(payloadUnknown);
  const eventNameRaw = readEventName(payloadUnknown) || type || event || "";
  const eventKey = eventNameRaw ? normalizeEventKey(eventNameRaw) : "";
  const eventLabel = eventNameRaw || "unknown";
  const summary =
    isObject(payloadUnknown)
      ? {
          companyId: hasKey(payloadUnknown, "companyId") && isString(payloadUnknown.companyId)
            ? payloadUnknown.companyId
            : "",
          locationId: hasKey(payloadUnknown, "locationId") && isString(payloadUnknown.locationId)
            ? payloadUnknown.locationId
            : "",
          locationsCount: Array.isArray((payloadUnknown as { locations?: unknown }).locations)
            ? ((payloadUnknown as { locations?: unknown }).locations as unknown[]).length
            : 0,
        }
      : { companyId: "", locationId: "", locationsCount: 0 };

  const planId = pickString(payloadUnknown, "planId");
  const webhookId = pickString(payloadUnknown, "webhookId");
  const isBillingEvent = eventKey ? BILLING_EVENT_KEYS.has(eventKey) : false;
  const isContactEvent = eventKey.startsWith("contact");
  const { contactId, source: contactIdSource } = readContactId(payloadUnknown, eventKey, webhookId);

  const logHeaders = pickLogHeaders(req.headers);

  // ---------- INSTALL ----------
  if (action === "install") {
    try {
      await logRawWebhook({
        eventName: eventLabel,
        eventKey,
        action,
        webhookId,
        companyId: summary.companyId,
        locationId: summary.locationId,
        planId,
        contactId,
        contactIdSource,
        rawBody: rawText,
        isBillingEvent,
        headers: logHeaders,
      });
    } catch (e) {
      console.error("[marketplace] webhook raw log failed", { event: eventLabel, err: String(e) });
    }

    console.info("[marketplace] install", {
      companyId: summary.companyId || null,
      locationId: summary.locationId || null,
      webhookId: webhookId || null,
    });
    if (summary.locationId) {
      try {
        await ensureLocationInstallRecord({ locationId: summary.locationId, agencyId: summary.companyId });
      } catch (e) {
        console.error("[marketplace] install seed failed", {
          locationId: summary.locationId,
          companyId: summary.companyId,
          err: String(e),
        });
      }
    }
    return NextResponse.json({ ok: true, captured: true, note: "install captured" }, { status: 200 });
  }

  // ---------- BILLING / PLAN EVENTS ----------
  if (isBillingEvent) {
    const eventLabel = eventNameRaw || type || event || "unknown";
    try {
      await logBillingWebhookCapture({
        eventName: eventLabel,
        eventKey,
        webhookId,
        companyId: summary.companyId,
        locationId: summary.locationId,
        planId,
        contactId,
        contactIdSource,
        rawBody: rawText,
        payload: payloadUnknown,
        headers: logHeaders,
      });
    } catch (e) {
      console.error("[marketplace] billing webhook log failed", { event: eventLabel, err: String(e) });
    }

    console.info("[marketplace] billing webhook", {
      event: eventLabel,
      companyId: summary.companyId || null,
      locationId: summary.locationId || null,
      planId: planId || null,
      webhookId: webhookId || null,
    });

    return NextResponse.json({ ok: true, captured: true, event: eventLabel }, { status: 200 });
  }

  // ---------- UNINSTALL ----------
  if (action === "uninstall") {
    try {
      await logRawWebhook({
        eventName: eventLabel,
        eventKey,
        action,
        webhookId,
        companyId: summary.companyId,
        locationId: summary.locationId,
        planId,
        contactId,
        contactIdSource,
        rawBody: rawText,
        isBillingEvent,
        headers: logHeaders,
      });
    } catch (e) {
      console.error("[marketplace] webhook raw log failed", { event: eventLabel, err: String(e) });
    }

    console.info("[marketplace] uninstall", {
      companyId: summary.companyId || null,
      locationId: summary.locationId || null,
      webhookId: webhookId || null,
    });

    return NextResponse.json({ ok: true, captured: true, note: "uninstall logging only" }, { status: 200 });
  }

  if (isContactEvent) {
    try {
      await logRawWebhook({
        eventName: eventLabel,
        eventKey,
        action,
        webhookId,
        companyId: summary.companyId,
        locationId: summary.locationId,
        planId,
        contactId,
        contactIdSource,
        rawBody: rawText,
        isBillingEvent,
        headers: logHeaders,
      });
    } catch (e) {
      console.error("[marketplace] webhook raw log failed", { event: eventLabel, err: String(e) });
    }

    console.info("[marketplace] contact webhook", {
      event: eventLabel,
      locationId: summary.locationId || null,
      contactId: contactId || null,
      contactIdSource,
      webhookId: webhookId || null,
    });

    const isContactDeleteEvent = eventKey.includes("contact") && eventKey.includes("delete");
    if (isContactDeleteEvent && summary.locationId && contactId) {
      const result = await cleanupContactSubmissions({
        locationId: summary.locationId,
        contactId,
      });
      console.info("[marketplace] contact delete cleanup", {
        locationId: summary.locationId,
        contactId,
        submissionsDeleted: result.submissionsDeleted,
        submissionsDecremented: result.submissionsDecremented,
        markersDeleted: result.markersDeleted,
        usersUpdated: result.usersUpdated,
        locationUpdated: result.locationUpdated,
        storageDeleted: result.storageDeleted,
        webhookId: webhookId || null,
      });
    }
    return NextResponse.json({ ok: true, ignored: true, event: eventLabel }, { status: 200 });
  }

  return NextResponse.json({ ok: true, ignored: true }, { status: 200 });
}
