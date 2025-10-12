// src/app/api/auth/complete-signup/route.ts
import { NextResponse } from "next/server";
import { getAdminApp, db } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";
import { ghlFetch } from "@/lib/ghlClient";

export const runtime = "nodejs";

type Body = {
  idToken: string;
  email?: string;
  firstName: string;
  lastName: string;
  agencyId?: string | null;
  locationId: string;
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
    } = (await req.json()) as Body;

    if (!idToken) return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    if (!locationId || !String(locationId).trim())
      return NextResponse.json({ error: "Missing locationId" }, { status: 400 });
    if (!firstName?.trim() || !lastName?.trim())
      return NextResponse.json({ error: "Missing first/last name" }, { status: 400 });

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
      } catch {}
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
        role: "admin" as const,
        isAdmin: true,
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

      const locProfile = { ...baseProfile };
      if (!luSnap.exists) {
        tx.set(locUserRef, { ...locProfile, createdAt: now });
      } else {
        tx.set(locUserRef, { ...locProfile }, { merge: true });
      }
    });

    // Attempt to look up and persist the corresponding GHL user ID based on email.
    // The HighLevel "Get User by Location" endpoint returns an array of users for a
    // given location when provided with the `locationId` query parameter【724459568743161†L0-L18】.
    // After creating the Firebase auth user, we fetch the list of users from GHL
    // and match on email to retrieve the external user ID.  Any failures here
    // should not abort signup; they are logged silently.
    try {
      const locId = String(locationId || "").trim();
      const emailLc = (userEmail || email || "").trim().toLowerCase();
      if (locId && emailLc) {
        const accessToken = await getValidAccessTokenForLocation(locId);
        const resp = await ghlFetch<{ users?: Array<{ id: string; email?: string }>; data?: { users?: Array<{ id: string; email?: string }> } }>(
          "/users/",
          {
            accessToken,
            query: { locationId: locId },
          },
        );
        const list =
          (resp as { users?: Array<{ id: string; email?: string }> }).users ??
          (resp as { data?: { users?: Array<{ id: string; email?: string }> } }).data?.users ??
          [];
        const match = Array.isArray(list)
          ? list.find((u) => typeof u?.email === "string" && u.email.trim().toLowerCase() === emailLc)
          : undefined;
        const ghlId = match?.id;
        if (typeof ghlId === "string" && ghlId.trim()) {
          const update = { ghlUserId: ghlId.trim() } as Record<string, unknown>;
          await db().collection("users").doc(uid).set(update, { merge: true });
          await db().collection("locations").doc(locId).collection("users").doc(uid).set(update, { merge: true });
        }
      }
    } catch {
      // Swallow any errors while syncing GHL user ID.  These will not block user creation.
    }

    return NextResponse.json({ ok: true, uid }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return NextResponse.json({ error: `complete-signup failed: ${msg}` }, { status: 500 });
  }
}
