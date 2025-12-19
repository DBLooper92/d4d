import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

function bad(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

function parseLocationIds(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const clientId = (u.searchParams.get("clientId") || u.searchParams.get("client_id") || "").trim();
  const installType = (u.searchParams.get("installType") || u.searchParams.get("install_type") || "").trim();
  const companyId = (u.searchParams.get("companyId") || u.searchParams.get("company_id") || "").trim();
  const locationIds = parseLocationIds(u.searchParams.get("locationId") || u.searchParams.get("location_id"));
  const planId = (u.searchParams.get("planId") || u.searchParams.get("plan_id") || "").trim();

  if (!clientId) return bad(400, "Missing clientId");
  if (!installType) return bad(400, "Missing installType");
  if (installType.toLowerCase() === "location" && !locationIds.length) {
    return bad(400, "locationId required for location installs");
  }
  if (installType.toLowerCase() === "company" && !companyId) {
    return bad(400, "companyId required for company installs");
  }

  const firestore = db();
  const now = FieldValue.serverTimestamp();
  const saved: string[] = [];

  if (locationIds.length) {
    for (const locId of locationIds) {
      const docId = `${companyId || "company-unknown"}-${locId}`;
      await firestore.collection("billingInstalls").doc(docId).set(
        {
          clientId,
          installType,
          companyId: companyId || null,
          locationId: locId,
          planId: planId || null,
          status: "pending_billing",
          createdAt: now,
          updatedAt: now,
        },
        { merge: true },
      );
      saved.push(locId);
    }
  } else if (companyId) {
    const docId = `company-${companyId}`;
    await firestore.collection("billingInstalls").doc(docId).set(
      {
        clientId,
        installType,
        companyId,
        planId: planId || null,
        status: "pending_billing",
        createdAt: now,
        updatedAt: now,
      },
      { merge: true },
    );
    saved.push(companyId);
  }

  return NextResponse.json({
    ok: true,
    clientId,
    installType,
    companyId: companyId || null,
    locationIds: saved,
    planId: planId || null,
  });
}
