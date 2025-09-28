// src/app/api/auth/complete-signup/route.ts
import { NextResponse } from "next/server";
import { getAdminApp, db } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

type Body = {
  idToken: string;
  email?: string;
  firstName: string;
  lastName: string;
  agencyId?: string | null;
  locationId: string;
};

export async function POST(req: Request) {
  try {
    const { idToken, email, firstName, lastName, agencyId, locationId } = (await req.json()) as Body;

    if (!idToken) {
      return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    }
    if (!locationId || !String(locationId).trim()) {
      return NextResponse.json({ error: "Missing locationId" }, { status: 400 });
    }
    if (!firstName?.trim() || !lastName?.trim()) {
      return NextResponse.json({ error: "Missing first/last name" }, { status: 400 });
    }

    const admin = getAdminApp();
    const auth = admin.auth();

    const decoded = await auth.verifyIdToken(idToken);
    const uid = decoded.uid;
    const userEmail = (decoded.email || email || "").trim();

    const now = FieldValue.serverTimestamp();

    const usersRef = db().collection("users").doc(uid);
    const locUserRef = db().collection("locations").doc(locationId).collection("users").doc(uid);

    await db().runTransaction(async (tx) => {
      const uSnap = await tx.get(usersRef);
      const luSnap = await tx.get(locUserRef);

      const baseProfile = {
        uid,
        email: userEmail || null,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        updatedAt: now,
      };

      // Parent collection: users/{uid} (includes agencyId, locationId)
      if (!uSnap.exists) {
        tx.set(usersRef, { ...baseProfile, agencyId: agencyId ?? null, locationId, createdAt: now });
      } else {
        tx.set(
          usersRef,
          { ...baseProfile, agencyId: agencyId ?? uSnap.get("agencyId") ?? null, locationId },
          { merge: true },
        );
      }

      // Subcollection: locations/{locationId}/users/{uid} (no agencyId/locationId in doc body per spec)
      if (!luSnap.exists) {
        tx.set(locUserRef, { ...baseProfile, createdAt: now });
      } else {
        tx.set(locUserRef, { ...baseProfile }, { merge: true });
      }
    });

    return NextResponse.json({ ok: true, uid }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return NextResponse.json({ error: `complete-signup failed: ${msg}` }, { status: 500 });
  }
}
