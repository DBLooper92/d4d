import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";
import { lcHeaders, getGhlConfig } from "@/lib/ghl";
import { db } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

type SubscriptionPlan = {
  resellingAmount?: number;
  baseAmount?: number;
  planId?: string;
  features?: string[];
  paymentType?: string;
  name?: string;
  paymentTime?: string;
};

type UsagePlan = {
  productType?: string;
  productName?: string;
  usageUnit?: string;
  meterId?: string;
  meterName?: string;
  fixedPricePerUnit?: number;
  priceType?: string;
  minPricePerUnit?: string;
  maxPricePerUnit?: string;
  executionLimitPerCycle?: number;
};

type RebillingResponse = {
  plans?: {
    subscription?: SubscriptionPlan[];
    usage?: UsagePlan[];
  };
};

async function fetchRebillingConfig(locationId: string) {
  const accessToken = await getValidAccessTokenForLocation(locationId);
  const { integrationId } = getGhlConfig();
  if (!integrationId) {
    throw new Error("Missing GHL_INTEGRATION_ID for rebilling fetch");
  }

  const url = `https://services.leadconnectorhq.com/marketplace/app/${encodeURIComponent(integrationId)}/rebilling-config/location/${encodeURIComponent(locationId)}`;
  const resp = await fetch(url, { headers: lcHeaders(accessToken), cache: "no-store" });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Rebilling fetch failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  let json: RebillingResponse = {};
  try {
    json = text ? (JSON.parse(text) as RebillingResponse) : {};
  } catch {
    /* keep empty */
  }
  return json;
}

function cleanPlanId(planId?: string | null) {
  if (typeof planId !== "string") return null;
  const t = planId.trim();
  return t.length ? t : null;
}

export async function reconcilePlanFromRebilling(locationId: string, companyId?: string | null) {
  const data = await fetchRebillingConfig(locationId);
  const subscription = data.plans?.subscription ?? [];
  const usage = data.plans?.usage ?? [];

  const primary = subscription[0] ?? null;
  const planId = cleanPlanId(primary?.planId);
  const planName = typeof primary?.name === "string" && primary.name.trim() ? primary.name.trim() : null;
  const paymentType =
    typeof primary?.paymentType === "string" && primary.paymentType.trim() ? primary.paymentType.trim() : null;

  const planFields: Record<string, unknown> = {
    ghlPlanStatus: planId ? "active" : "inactive",
    ghlPlanId: planId,
    ghlPlanName: planName,
    ghlPlanPaymentType: paymentType,
    ghlPlanResellAmount: typeof primary?.resellingAmount === "number" ? primary.resellingAmount : null,
    ghlPlanBaseAmount: typeof primary?.baseAmount === "number" ? primary.baseAmount : null,
    ghlPlanFeatures: Array.isArray(primary?.features) ? primary?.features : [],
    ghlPlanUpdatedAt: FieldValue.serverTimestamp(),
    ghlBillingUpdatedAt: FieldValue.serverTimestamp(),
    ghlUsageMeters: usage,
  };

  const firestore = db();

  await firestore.collection("locations").doc(locationId).set(
    {
      locationId,
      ...(companyId ? { agencyId: companyId } : {}),
      ...planFields,
    },
    { merge: true },
  );

  if (companyId) {
    await firestore
      .collection("agencies")
      .doc(companyId)
      .collection("locations")
      .doc(locationId)
      .set(
        {
          locationId,
          agencyId: companyId,
          ...planFields,
        },
        { merge: true },
      );
  }

  return {
    planId,
    planName,
    paymentType,
    subscriptionCount: subscription.length,
    usageCount: usage.length,
  };
}
