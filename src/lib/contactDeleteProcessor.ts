import { db } from "@/lib/firebaseAdmin";
import { FieldValue, type DocumentData, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { cleanupSubmissionsAndMarkers } from "@/lib/submissionCleanup";
import { enqueueReconcileTask } from "@/lib/reconcileTasks";

export type ContactDeleteProcessResult = {
  submissionsDeleted: number;
  markersDeleted: number;
  usersUpdated: number;
  locationUpdated: boolean;
  storageDeleted: number;
  submissionsMarked: number;
  reconcileQueued: number;
  reconcileDeduped: number;
};

const RECONCILE_GROUPS_COLLECTION = "ghl_reconcile_groups";

function coerceString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readSubmissionGroupId(data: Record<string, unknown>): string {
  const skiptrace = (data as { skiptraceData?: { groupId?: unknown } }).skiptraceData;
  return coerceString(skiptrace?.groupId);
}

export async function processContactDeleteEvent(params: {
  locationId: string;
  contactId: string;
  baseUrl: string;
}): Promise<ContactDeleteProcessResult> {
  const firestore = db();
  const submissionsCol = firestore.collection("locations").doc(params.locationId).collection("submissions");

  const [nestedSnap, flatSnap, arraySnap] = await Promise.all([
    submissionsCol.where("ghl.contactId", "==", params.contactId).get(),
    submissionsCol.where("contactId", "==", params.contactId).get(),
    submissionsCol.where("ghl.contactIds", "array-contains", params.contactId).get(),
  ]);

  const submissionMap = new Map<string, QueryDocumentSnapshot<DocumentData>>();
  nestedSnap.docs.forEach((docSnap) => submissionMap.set(docSnap.id, docSnap));
  flatSnap.docs.forEach((docSnap) => submissionMap.set(docSnap.id, docSnap));
  arraySnap.docs.forEach((docSnap) => submissionMap.set(docSnap.id, docSnap));

  if (submissionMap.size === 0) {
    return {
      submissionsDeleted: 0,
      markersDeleted: 0,
      usersUpdated: 0,
      locationUpdated: false,
      storageDeleted: 0,
      submissionsMarked: 0,
      reconcileQueued: 0,
      reconcileDeduped: 0,
    };
  }

  const immediateDocs: Array<QueryDocumentSnapshot<DocumentData>> = [];
  const reconcileGroups = new Map<string, Array<QueryDocumentSnapshot<DocumentData>>>();

  for (const docSnap of submissionMap.values()) {
    const data = docSnap.data() as Record<string, unknown>;
    const groupId = readSubmissionGroupId(data);
    if (groupId) {
      const list = reconcileGroups.get(groupId) ?? [];
      list.push(docSnap);
      reconcileGroups.set(groupId, list);
    } else {
      immediateDocs.push(docSnap);
    }
  }

  const cleanupResult = await cleanupSubmissionsAndMarkers({
    locationId: params.locationId,
    submissions: immediateDocs,
  });

  if (reconcileGroups.size > 0 && !params.baseUrl) {
    throw new Error("Missing baseUrl for reconcile tasks");
  }

  let submissionsMarked = 0;
  if (reconcileGroups.size > 0) {
    let batch = firestore.batch();
    let opCount = 0;
    for (const [groupId, docs] of reconcileGroups.entries()) {
      const groupRef = firestore
        .collection("locations")
        .doc(params.locationId)
        .collection(RECONCILE_GROUPS_COLLECTION)
        .doc(groupId);
      batch.set(
        groupRef,
        {
          groupId,
          reconcilePending: true,
          reconcileRequestedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      opCount += 1;
      if (opCount >= 450) {
        await batch.commit();
        batch = firestore.batch();
        opCount = 0;
      }
      for (const docSnap of docs) {
        batch.set(
          docSnap.ref,
          {
            "ghl.reconcilePending": true,
            "ghl.reconcileRequestedAt": FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        submissionsMarked += 1;
        opCount += 1;
        if (opCount >= 450) {
          await batch.commit();
          batch = firestore.batch();
          opCount = 0;
        }
      }
    }
    if (opCount > 0) {
      await batch.commit();
    }
  }

  let reconcileQueued = 0;
  let reconcileDeduped = 0;
  for (const groupId of reconcileGroups.keys()) {
    const result = await enqueueReconcileTask({
      locationId: params.locationId,
      groupId,
      baseUrl: params.baseUrl,
      attempt: 0,
      delaySeconds: 0,
    });
    if (result.queued) reconcileQueued += 1;
    if (result.deduped) reconcileDeduped += 1;
  }

  return {
    submissionsDeleted: cleanupResult.submissionsDeleted,
    markersDeleted: cleanupResult.markersDeleted,
    usersUpdated: cleanupResult.usersUpdated,
    locationUpdated: cleanupResult.locationUpdated,
    storageDeleted: cleanupResult.storageDeleted,
    submissionsMarked,
    reconcileQueued,
    reconcileDeduped,
  };
}
