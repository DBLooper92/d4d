// src/app/api/webhooks/ghl/marketplace/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
import { FieldValue, type DocumentData, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { ensureLocationInstallRecord } from "@/lib/locationInstall";
import { cleanupSubmissionsAndMarkers } from "@/lib/submissionCleanup";
import { enqueueReconcileTask, resolveTaskBaseUrlFromRequest } from "@/lib/reconcileTasks";

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
function readSubmissionGroupId(data: Record<string, unknown>): string {
  const skiptrace = (data as { skiptraceData?: { groupId?: unknown } }).skiptraceData;
  return coerceString(skiptrace?.groupId);
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
const RECONCILE_GROUPS_COLLECTION = "ghl_reconcile_groups";

function readEventName(payload: unknown): string {
  if (!isObject(payload)) return "";
  const candidates = ["type", "event", "eventType", "name"];
  for (const key of candidates) {
    const value = pickString(payload, key);
    if (value) return value;
  }
  return "";
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
  baseUrl: string;
}): Promise<{
  submissionsDeleted: number;
  markersDeleted: number;
  usersUpdated: number;
  locationUpdated: boolean;
  storageDeleted: number;
  submissionsMarked: number;
  reconcileQueued: number;
  reconcileDeduped: number;
}> {
  const firestore = db();
  const submissionsCol = firestore.collection("locations").doc(params.locationId).collection("submissions");

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
      markersDeleted: 0,
      usersUpdated: 0,
      locationUpdated: false,
      storageDeleted: 0,
      submissionsMarked: 0,
      reconcileQueued: 0,
      reconcileDeduped: 0,
    };
  }

  const immediateDocs: Array<QueryDocumentSnapshot<DocumentData>> = [];
  const reconcileGroups = new Map<string, Array<QueryDocumentSnapshot<DocumentData>>>();

  for (const docSnap of submissionMap.values()) {
    const data = docSnap.data() as Record<string, unknown>;
    const groupId = readSubmissionGroupId(data);
    if (groupId) {
      const list = reconcileGroups.get(groupId) ?? [];
      list.push(docSnap);
      reconcileGroups.set(groupId, list);
    } else {
      immediateDocs.push(docSnap);
    }
  }

  const cleanupResult = await cleanupSubmissionsAndMarkers({
    locationId: params.locationId,
    submissions: immediateDocs,
  });

  let submissionsMarked = 0;
  if (reconcileGroups.size > 0) {
    let batch = firestore.batch();
    let opCount = 0;
    for (const [groupId, docs] of reconcileGroups.entries()) {
      const groupRef = firestore
        .collection("locations")
        .doc(params.locationId)
        .collection(RECONCILE_GROUPS_COLLECTION)
        .doc(groupId);
      batch.set(
        groupRef,
        {
          groupId,
          reconcilePending: true,
          reconcileRequestedAt: FieldValue.serverTimestamp(),
          reconcileAttempts: 0,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      opCount += 1;
      if (opCount >= 450) {
        await batch.commit();
        batch = firestore.batch();
        opCount = 0;
      }
      for (const docSnap of docs) {
        batch.set(
          docSnap.ref,
          {
            "ghl.reconcilePending": true,
            "ghl.reconcileRequestedAt": FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        submissionsMarked += 1;
        opCount += 1;
        if (opCount >= 450) {
          await batch.commit();
          batch = firestore.batch();
          opCount = 0;
        }
      }
    }
    if (opCount > 0) {
      await batch.commit();
    }
  }

  let reconcileQueued = 0;
  let reconcileDeduped = 0;
  for (const groupId of reconcileGroups.keys()) {
    const result = await enqueueReconcileTask({
      locationId: params.locationId,
      groupId,
      baseUrl: params.baseUrl,
      attempt: 0,
      delaySeconds: 120,
    });
    if (result.queued) reconcileQueued += 1;
    if (result.deduped) reconcileDeduped += 1;
  }

  return {
    submissionsDeleted: cleanupResult.submissionsDeleted,
    markersDeleted: cleanupResult.markersDeleted,
    usersUpdated: cleanupResult.usersUpdated,
    locationUpdated: cleanupResult.locationUpdated,
    storageDeleted: cleanupResult.storageDeleted,
    submissionsMarked,
    reconcileQueued,
    reconcileDeduped,
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
      const baseUrl = resolveTaskBaseUrlFromRequest(req);
      const result = await cleanupContactSubmissions({
        locationId: summary.locationId,
        contactId,
        baseUrl,
      });
      console.info("[marketplace] contact delete cleanup", {
        locationId: summary.locationId,
        contactId,
        submissionsDeleted: result.submissionsDeleted,
        markersDeleted: result.markersDeleted,
        usersUpdated: result.usersUpdated,
        locationUpdated: result.locationUpdated,
        storageDeleted: result.storageDeleted,
        submissionsMarked: result.submissionsMarked,
        reconcileQueued: result.reconcileQueued,
        reconcileDeduped: result.reconcileDeduped,
        webhookId: webhookId || null,
      });
    }
    return NextResponse.json({ ok: true, ignored: true, event: eventLabel }, { status: 200 });
  }

  return NextResponse.json({ ok: true, ignored: true }, { status: 200 });
}
