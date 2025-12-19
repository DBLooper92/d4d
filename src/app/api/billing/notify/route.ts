import { NextResponse } from "next/server";
import { sendBillingWebhookAndPersist, type BillingWebhookInput, persistPlanStateFromBilling } from "@/lib/ghlBilling";

export const runtime = "nodejs";

type Body = Partial<BillingWebhookInput> & { skipWebhook?: boolean };

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function bad(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return bad(400, "Invalid JSON body");
  }

  const amount = toNumber(body.amount);
  if (amount === null) return bad(400, "amount is required and must be a number");

  const status = (body.status || "").toUpperCase() as BillingWebhookInput["status"];
  if (status !== "COMPLETED" && status !== "FAILED") return bad(400, "status must be COMPLETED or FAILED");

  const paymentType = body.paymentType === "one_time" ? "one_time" : body.paymentType === "recurring" ? "recurring" : null;
  if (!paymentType) return bad(400, "paymentType must be recurring or one_time");

  const authType: BillingWebhookInput["authType"] =
    body.authType === "company" ? "company" : "location";

  if (authType === "location" && !(body.locationId || body.companyId)) {
    return bad(400, "locationId is required for location billing");
  }
  if (authType === "company" && !body.companyId) {
    return bad(400, "companyId is required for company billing");
  }

  const payload: BillingWebhookInput = {
    authType,
    clientId: body.clientId,
    locationId: body.locationId,
    companyId: body.companyId,
    subscriptionId: body.subscriptionId,
    paymentId: body.paymentId,
    amount,
    status,
    paymentType,
    planId: body.planId,
  };

  try {
    if (body.skipWebhook) {
      await persistPlanStateFromBilling(payload);
    } else {
      await sendBillingWebhookAndPersist(payload);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    return bad(502, message);
  }
}
