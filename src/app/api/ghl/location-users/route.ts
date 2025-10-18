import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebaseAdmin";

// GET /api/agency/locations?agencyId=...
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const agencyId = searchParams.get("agencyId");

  if (!agencyId) {
    return NextResponse.json({ error: "Missing agencyId" }, { status: 400 });
  }

  try {
    const q = await getDb()
      .collection("locations")
      .where("agencyId", "==", agencyId)
      .limit(500)
      .get();

    const locations = q.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) }));
    return NextResponse.json({ locations });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to load locations", detail: msg }, { status: 500 });
  }
}
