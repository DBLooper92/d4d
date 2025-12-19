import { db } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

const BILLING_WEBHOOK_URL = "https://services.leadconnectorhq.com/oauth/billing/webhook";

type BillingStatus = "COMPLETED" | "FAILED";
type BillingPaymentType = "recurring" | "one_time";
type BillingAuthType = "location" | "company";

export type BillingWebhookInput = {
  authType: BillingAuthType;
  clientId?: string;
  locationId?: string;
  companyId?: string;
  subscriptionId?: string;
  paymentId?: string;
  amount: number;
  status: BillingStatus;
  paymentType: BillingPaymentType;
  planId?: string | null;
};

function cleanString(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function cleanAmount(value: number): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

async function updateLocationPlanState(params: {
  locationId: string;
  companyId?: string | null;
  fields: Record<string, unknown>;
}) {
  const firestore = db();
  const nowFields = { ghlBillingUpdatedAt: FieldValue.serverTimestamp() };
  await firestore.collection("locations").doc(params.locationId).set(
    {
      locationId: params.locationId,
      ...(params.companyId ? { agencyId: params.companyId } : {}),
      ...nowFields,
      ...params.fields,
    },
    { merge: true },
  );

  if (params.companyId) {
    await firestore.collection("agencies").doc(params.companyId).collection("locations").doc(params.locationId).set(
      {
        locationId: params.locationId,
        agencyId: params.companyId,
        ...nowFields,
        ...params.fields,
      },
      { merge: true },
    );
  }
}

async function updateAgencyPlanState(params: { companyId: string; fields: Record<string, unknown> }) {
  const firestore = db();
  await firestore.collection("agencies").doc(params.companyId).set(
    {
      agencyId: params.companyId,
      ghlBillingUpdatedAt: FieldValue.serverTimestamp(),
      ...params.fields,
    },
    { merge: true },
  );
}

function buildPlanFields(input: BillingWebhookInput) {
  const status = input.status;
  const planId = status === "COMPLETED" ? cleanString(input.planId) : null;
  const subscriptionId = status === "COMPLETED" ? cleanString(input.subscriptionId) : null;
  const paymentId = status === "COMPLETED" ? cleanString(input.paymentId) : null;
  const amount = cleanAmount(input.amount);

  const fields: Record<string, unknown> = {
    ghlPlanStatus: status === "COMPLETED" ? "active" : "inactive",
    ghlBillingStatus: status,
    ghlPaymentType: input.paymentType,
    ghlPlanStatusReason: status === "FAILED" ? "billing_failed" : FieldValue.delete(),
  };

  fields.ghlPlanId = planId;
  fields.ghlSubscriptionId = subscriptionId;
  fields.ghlPaymentId = paymentId;
  fields.ghlBillingAmount = amount;

  return fields;
}

async function callGhlBillingWebhook(input: BillingWebhookInput) {
  const clientKey = cleanString(process.env.GHL_BILLING_CLIENT_KEY) ?? cleanString(process.env.GHL_CLIENT_ID);
  const clientSecret =
    cleanString(process.env.GHL_BILLING_CLIENT_SECRET) ?? cleanString(process.env.GHL_CLIENT_SECRET);

  if (!clientKey || !clientSecret) {
    throw new Error("Missing billing credentials (GHL_BILLING_CLIENT_KEY/SECRET or GHL_CLIENT_ID/SECRET)");
  }

  const clientId = cleanString(input.clientId) ?? clientKey;

  const payload: Record<string, unknown> = {
    clientId,
    authType: input.authType,
    amount: input.amount,
    status: input.status,
    paymentType: input.paymentType,
  };

  if (input.authType === "location") {
    payload.locationId = input.locationId;
  } else {
    payload.companyId = input.companyId;
  }

  if (input.subscriptionId) payload.subscriptionId = input.subscriptionId;
  if (input.paymentId) payload.paymentId = input.paymentId;

  const response = await fetch(BILLING_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ghl-client-key": clientKey,
      "x-ghl-client-secret": clientSecret,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Billing webhook failed (${response.status}): ${text.slice(0, 500)}`);
  }

  return { ok: true as const, raw: text };
}

export async function sendBillingWebhookAndPersist(input: BillingWebhookInput) {
  if (input.authType === "location" && !cleanString(input.locationId)) {
    throw new Error("locationId is required when authType is location");
  }
  if (input.authType === "company" && !cleanString(input.companyId)) {
    throw new Error("companyId is required when authType is company");
  }

  await callGhlBillingWebhook(input);

  const fields = buildPlanFields(input);

  if (input.authType === "location" && input.locationId) {
    await updateLocationPlanState({
      locationId: input.locationId,
      companyId: cleanString(input.companyId),
      fields,
    });
  } else if (input.authType === "company" && input.companyId) {
    await updateAgencyPlanState({ companyId: input.companyId, fields });
  }

  return { ok: true as const };
}

export async function persistPlanStateFromBilling(input: BillingWebhookInput) {
  const fields = buildPlanFields(input);
  if (input.authType === "location" && input.locationId) {
    await updateLocationPlanState({
      locationId: input.locationId,
      companyId: cleanString(input.companyId),
      fields,
    });
  } else if (input.authType === "company" && input.companyId) {
    await updateAgencyPlanState({ companyId: input.companyId, fields });
  }
  return { ok: true as const };
}
