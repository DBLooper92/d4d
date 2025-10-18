// src/app/api/agency/locations/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

type LocationDoc = {
  locationId?: string;
  name?: string;
  isInstalled?: boolean;
  refreshToken?: string;
  updatedAt?: unknown;
  agencyId?: string;
};

type LocationItem = {
  locationId: string;
  name: string | null;
  isInstalled: boolean;
  updatedAt: unknown | null;
};

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

    const items: LocationItem[] = q.docs.map((d) => {
      const data = (d.data() ?? {}) as LocationDoc;
      return {
        locationId: (data.locationId && data.locationId.trim()) || d.id,
        name: typeof data.name === "string" ? data.name : null,
        isInstalled: Boolean(data.isInstalled) || Boolean(data.refreshToken),
        updatedAt: data.updatedAt ?? null,
      };
    });

    return NextResponse.json(
      { agencyId, count: items.length, items },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Query failed: ${msg}` }, { status: 500 });
  }
}
