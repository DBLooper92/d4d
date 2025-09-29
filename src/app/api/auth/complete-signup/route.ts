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
  // optional identity context from SSO
  ghlUserId?: string | null;
  ghlRole?: string | null;
  ghlIsAgencyOwner?: boolean | null;
};

type UserDoc = {
  agencyId?: string | null;
  locationId?: string | null;
  [k: string]: unknown;
};

export async function POST(req: Request) {
  try {
    const {
      idToken,
      email,
      firstName,
      lastName,
      agencyId: agencyIdIn,
      locationId,
      ghlUserId = null,
      ghlRole = null,
      ghlIsAgencyOwner = null,
    } = (await req.json()) as Body;

    if (!idToken) return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    if (!locationId || !String(locationId).trim())
      return NextResponse.json({ error: "Missing locationId" }, { status: 400 });
    if (!firstName?.trim() || !lastName?.trim())
      return NextResponse.json({ error: "Missing first/last name" }, { status: 400 });

    // Try to resolve agencyId server-side if client didn't have it
    let agencyId = agencyIdIn ?? null;
    if (!agencyId) {
      try {
        const locSnap = await db().collection("locations").doc(locationId).get();
        if (locSnap.exists) {
          const locData = (locSnap.data() || {}) as { agencyId?: string };
          if (locData.agencyId && String(locData.agencyId).trim()) {
            agencyId = String(locData.agencyId).trim();
          }
        }
      } catch {
        /* ignore and proceed; agencyId can remain null */
      }
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
        // keep GHL identity hints on the user too
        ghlUserId: ghlUserId || null,
        ghlRole: ghlRole || null,
        ghlIsAgencyOwner: ghlIsAgencyOwner ?? null,
      };

      if (!uSnap.exists) {
        tx.set(usersRef, { ...baseProfile, agencyId: agencyId ?? null, locationId, createdAt: now });
      } else {
        const existing = (uSnap.data() as UserDoc) || {};
        tx.set(
          usersRef,
          { ...baseProfile, agencyId: agencyId ?? existing.agencyId ?? null, locationId },
          { merge: true },
        );
      }

      // Location membership (store role here for per-location checks later)
      const locProfile = {
        ...baseProfile,
        role: ghlRole || null,
      };

      if (!luSnap.exists) {
        tx.set(locUserRef, { ...locProfile, createdAt: now });
      } else {
        tx.set(locUserRef, { ...locProfile }, { merge: true });
      }
    });

    return NextResponse.json({ ok: true, uid }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return NextResponse.json({ error: `complete-signup failed: ${msg}` }, { status: 500 });
  }
}
