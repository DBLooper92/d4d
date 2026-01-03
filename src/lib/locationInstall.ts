// Utilities for seeding location records during install flows.
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebaseAdmin";

type EnsureLocationInstallParams = {
  locationId: string;
  agencyId?: string | null;
};

/**
 * Ensure the base location document exists with install metadata and skiptrace defaults.
 * Adds skipTracesAvailable = 150 when the field is missing without overwriting existing values.
 */
export async function ensureLocationInstallRecord({ locationId, agencyId }: EnsureLocationInstallParams) {
  const locId = (locationId || "").trim();
  if (!locId) return;

  const agency = (agencyId || "").trim();
  const firestore = db();
  const ref = firestore.collection("locations").doc(locId);

  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    const payload: Record<string, unknown> = {
      locationId: locId,
      provider: "leadconnector",
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (agency) payload.agencyId = agency;

    const hasInstalledAt = snap.exists ? Boolean(snap.get("installedAt")) : false;
    const isInstalled = snap.exists ? snap.get("isInstalled") === true : false;

    if (!hasInstalledAt) payload.installedAt = FieldValue.serverTimestamp();
    if (!isInstalled) payload.isInstalled = true;

    const skipTracesAvailable = snap.exists ? snap.get("skipTracesAvailable") : undefined;
    if (typeof skipTracesAvailable !== "number") {
      payload.skipTracesAvailable = 150;
    }

    tx.set(ref, payload, { merge: true });
  });
}
