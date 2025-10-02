// src/app/api/agency/locations/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const agencyId = (url.searchParams.get("agencyId") || "").trim();
  if (!agencyId) {
    return NextResponse.json({ error: "Missing agencyId" }, { status: 400 });
  }

  try {
    const q = await db()
      .collection("locations")
      .where("agencyId", "==", agencyId)
      .limit(500)
      .get();

    const items = q.docs.map((d) => {
      const data = d.data() || {};
      return {
        locationId: data.locationId ?? d.id,
        name: typeof data.name === "string" ? data.name : null,
        isInstalled: Boolean(data.isInstalled) || Boolean(data.refreshToken),
        updatedAt: (data.updatedAt as unknown) ?? null,
      };
    });

    return NextResponse.json({ agencyId, count: items.length, items }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: `Query failed: ${(e as Error).message}` }, { status: 500 });
  }
}
