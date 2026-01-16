import { NextResponse } from "next/server";
import { processContactDeleteEvent } from "@/lib/contactDeleteProcessor";
import { resolveTaskBaseUrlFromEnv } from "@/lib/reconcileTasks";

export const runtime = "nodejs";

type ContactDeleteTask = {
  locationId?: unknown;
  contactId?: unknown;
  webhookId?: unknown;
  contactIdSource?: unknown;
  eventKey?: unknown;
  baseUrl?: unknown;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(req: Request) {
  const requiredToken = process.env.GHL_RECONCILE_TOKEN;
  if (requiredToken && req.headers.get("x-reconcile-token") !== requiredToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: ContactDeleteTask;
  try {
    payload = (await req.json()) as ContactDeleteTask;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const locationId = readString(payload.locationId);
  const contactId = readString(payload.contactId);
  const baseUrl = readString(payload.baseUrl) || resolveTaskBaseUrlFromEnv();

  if (!locationId || !contactId) {
    return NextResponse.json({ error: "Missing locationId or contactId" }, { status: 400 });
  }

  try {
    const result = await processContactDeleteEvent({
      locationId,
      contactId,
      baseUrl,
    });
    console.info("[contact-delete] processed", {
      locationId,
      contactId,
      webhookId: readString(payload.webhookId) || null,
      contactIdSource: readString(payload.contactIdSource) || null,
      eventKey: readString(payload.eventKey) || null,
      submissionsDeleted: result.submissionsDeleted,
      markersDeleted: result.markersDeleted,
      usersUpdated: result.usersUpdated,
      locationUpdated: result.locationUpdated,
      storageDeleted: result.storageDeleted,
      submissionsMarked: result.submissionsMarked,
      reconcileQueued: result.reconcileQueued,
      reconcileDeduped: result.reconcileDeduped,
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("[contact-delete] failed", {
      locationId,
      contactId,
      webhookId: readString(payload.webhookId) || null,
      err: String(err),
    });
    return NextResponse.json({ error: "Contact delete processing failed" }, { status: 500 });
  }
}
