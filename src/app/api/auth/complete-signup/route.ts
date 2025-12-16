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
  ghlUserId?: string | null;
  ghlCompanyId?: string | null;
  ghlLocationId?: string | null;
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
      ghlUserId: ghlUserIdIn,
      ghlCompanyId: ghlCompanyIdIn,
      ghlLocationId: ghlLocationIdIn,
    } = (await req.json()) as Body;

    if (!idToken) return NextResponse.json({ error: "Missing idToken" }, { status: 400 });
    if (!locationId || !String(locationId).trim())
      return NextResponse.json({ error: "Missing locationId" }, { status: 400 });
    if (!firstName?.trim() || !lastName?.trim())
      return NextResponse.json({ error: "Missing first/last name" }, { status: 400 });

    const normalizedLocationId = String(locationId).trim();
    const ghlUserId = typeof ghlUserIdIn === "string" && ghlUserIdIn.trim() ? ghlUserIdIn.trim() : null;
    const ghlCompanyId = typeof ghlCompanyIdIn === "string" && ghlCompanyIdIn.trim() ? ghlCompanyIdIn.trim() : null;
    const ghlLocationId =
      typeof ghlLocationIdIn === "string" && ghlLocationIdIn.trim() ? ghlLocationIdIn.trim() : null;
    const ghlLocationForDoc = ghlLocationId ?? normalizedLocationId;

    let agencyId = agencyIdIn ?? null;
    if (!agencyId) {
      try {
        const locSnap = await db().collection("locations").doc(normalizedLocationId).get();
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

    // Decide whether this signup should be the location admin (first owner) or a driver invited later.
    let adminExists = false;
    let invitedDriver = false;
    try {
      const locDoc = await db().collection("locations").doc(normalizedLocationId).get();
      const locData = (locDoc.data() || {}) as {
        invites?: Record<string, unknown>;
        adminUid?: string | null;
        adminGhlUserId?: string | null;
      };
      if (locData.adminUid || locData.adminGhlUserId) {
        adminExists = true;
      }
      if (!adminExists) {
        // If any user at this location is already marked admin, do not promote this signup.
        try {
          const usersCol = db().collection("locations").doc(normalizedLocationId).collection("users");
          const [flagSnap, roleSnap] = await Promise.all([
            usersCol.where("isAdmin", "==", true).limit(1).get(),
            usersCol.where("role", "==", "admin").limit(1).get(),
          ]);
          adminExists = !flagSnap.empty || !roleSnap.empty;
        } catch {
          /* ignore discovery errors */
        }
      }
      if (ghlUserId && locData.invites && typeof locData.invites === "object") {
        if (locData.invites[ghlUserId]) invitedDriver = true;
      }
    } catch {
      /* ignore lookup errors; default to admin when nothing is known */
    }

    const shouldBeAdmin = !invitedDriver && !adminExists;
    const role: "admin" | "driver" = shouldBeAdmin ? "admin" : "driver";
    const usersRef = db().collection("users").doc(uid);
    const locUserRef = db().collection("locations").doc(normalizedLocationId).collection("users").doc(uid);

    await db().runTransaction(async (tx) => {
      const uSnap = await tx.get(usersRef);
      const luSnap = await tx.get(locUserRef);

      const baseProfile = {
        uid,
        email: userEmail || null,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        updatedAt: now,
        role,
        isAdmin: shouldBeAdmin,
      };

      if (!uSnap.exists) {
        tx.set(usersRef, { ...baseProfile, agencyId: agencyId ?? null, locationId: normalizedLocationId, createdAt: now });
      } else {
        const existing = (uSnap.data() as UserDoc) || {};
        tx.set(
          usersRef,
          { ...baseProfile, agencyId: agencyId ?? existing.agencyId ?? null, locationId: normalizedLocationId },
          { merge: true },
        );
      }

      const locProfile = { ...baseProfile, locationId: normalizedLocationId };
      if (!luSnap.exists) {
        tx.set(locUserRef, { ...locProfile, createdAt: now });
      } else {
        tx.set(locUserRef, { ...locProfile }, { merge: true });
      }

      if (shouldBeAdmin) {
        tx.set(
          db().collection("locations").doc(normalizedLocationId),
          {
            adminUid: uid,
            adminGhlUserId: ghlUserId ?? null,
            adminSetAt: now,
          },
          { merge: true },
        );
      }
    });

    const persistGhlProfile = async (userIdValue: string | null) => {
      const payload = {
        ghl: {
          userId: userIdValue ?? null,
          companyId: ghlCompanyId ?? null,
          locationId: ghlLocationForDoc ?? null,
          updatedAt: Date.now(),
        },
      } as Record<string, unknown>;
      if (userIdValue) payload.ghlUserId = userIdValue;

      await Promise.all([usersRef.set(payload, { merge: true }), locUserRef.set(payload, { merge: true })]);
    };

    try {
      await persistGhlProfile(ghlUserId);
    } catch {
      /* ignore */
    }

    if (ghlUserId) {
      try {
        const inviteKey = `invites.${ghlUserId}`;
        await db().collection("locations").doc(normalizedLocationId).set(
          {
            [inviteKey]: {
              status: "accepted",
              firebaseUid: uid,
              acceptedAt: FieldValue.serverTimestamp(),
            },
          },
          { merge: true },
        );
      } catch {
        /* best-effort */
      }
    }

    return NextResponse.json({ ok: true, uid }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return NextResponse.json({ error: `complete-signup failed: ${msg}` }, { status: 500 });
  }
}
