// src/app/api/tokens/location/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/firebaseAdmin";
import { getGhlConfig, olog, scopeListFromTokenScope } from "@/lib/ghl";
import { exchangeRefreshToken } from "@/lib/ghlTokens";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const locationId = (url.searchParams.get("locationId") || "").trim();
  if (!locationId) {
    return NextResponse.json({ error: "Missing locationId" }, { status: 400 });
  }

  try {
    const doc = await db().collection("locations").doc(locationId).get();
    if (!doc.exists) {
      return NextResponse.json({ error: "Unknown location" }, { status: 404 });
    }
    const data = doc.data() || {};
    const refreshToken = String(data.refreshToken || "");
    if (!refreshToken) {
      return NextResponse.json({ error: "Location not installed / no refreshToken" }, { status: 409 });
    }

    const { clientId, clientSecret } = getGhlConfig();
    const tok = await exchangeRefreshToken(refreshToken, clientId, clientSecret);

    const scopesArr = scopeListFromTokenScope(tok.scope ?? "");

    // Log scope details to help validate marketplace permissions.
    olog("location token exchanged", {
      locationId,
      scopesCount: scopesArr.length,
      scopes: scopesArr,
      scopeRaw: tok.scope ?? "",
    });

    // Return the short-lived access token plus the parsed scope list for debugging.
    return NextResponse.json(
      {
        access_token: tok.access_token,
        scope: tok.scope || "",
        scopes: scopesArr,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return NextResponse.json({ error: `Exchange failed: ${(e as Error).message}` }, { status: 502 });
  }
}
