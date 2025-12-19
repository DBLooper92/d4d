import { NextResponse } from "next/server";
import { reconcilePlanFromRebilling } from "@/lib/ghlRebilling";

export const runtime = "nodejs";

function bad(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const locationId = u.searchParams.get("location_id") || u.searchParams.get("locationId") || "";
  const companyId = u.searchParams.get("company_id") || u.searchParams.get("companyId") || "";

  if (!locationId.trim()) return bad(400, "location_id is required");

  try {
    const result = await reconcilePlanFromRebilling(locationId.trim(), companyId.trim() || null);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    return bad(502, message);
  }
}
