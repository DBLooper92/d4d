import { db, getAdminApp } from "@/lib/firebaseAdmin";
import { FieldValue, type DocumentData, type DocumentReference, type QueryDocumentSnapshot, type WriteBatch } from "firebase-admin/firestore";

export type CleanupResult = {
  submissionsDeleted: number;
  markersDeleted: number;
  usersUpdated: number;
  locationUpdated: boolean;
  storageDeleted: number;
};

function coerceString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveStorageBucket(): string {
  const app = getAdminApp();
  const appBucket = (app.options as { storageBucket?: string }).storageBucket;
  if (appBucket && appBucket.trim().length > 0) return appBucket.trim();
  const envCandidates = ["FIREBASE_STORAGE_BUCKET", "FIREBASE_ADMIN_STORAGE_BUCKET", "GOOGLE_CLOUD_STORAGE_BUCKET"];
  for (const name of envCandidates) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return value.trim();
  }
  return "";
}

function decodeStoragePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseStorageUrl(url: string): { bucket: string; path: string } {
  if (!url) return { bucket: "", path: "" };
  if (url.startsWith("gs://")) {
    const withoutScheme = url.slice("gs://".length);
    const [bucket, ...rest] = withoutScheme.split("/");
    return { bucket: bucket || "", path: rest.join("/") };
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;
    if (host === "firebasestorage.googleapis.com") {
      const match = pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
      if (match) {
        return { bucket: match[1], path: decodeStoragePath(match[2]) };
      }
    }
    if (host === "storage.googleapis.com") {
      const altMatch = pathname.match(/^\/download\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/);
      if (altMatch) {
        return { bucket: altMatch[1], path: decodeStoragePath(altMatch[2]) };
      }
      const parts = pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const [bucket, ...rest] = parts;
        return { bucket, path: decodeStoragePath(rest.join("/")) };
      }
    }
  } catch {
    return { bucket: "", path: "" };
  }
  return { bucket: "", path: "" };
}

function collectStorageTargets(photo: unknown, fallbackBucket: string): Array<{ bucket: string; path: string }> {
  const targets: Array<{ bucket: string; path: string }> = [];
  const pushTarget = (bucket: string, path: string) => {
    const cleanBucket = bucket.trim();
    const cleanPath = path.trim().replace(/^\/+/, "");
    if (!cleanBucket || !cleanPath) return;
    targets.push({ bucket: cleanBucket, path: cleanPath });
  };

  if (typeof photo === "string") {
    if (photo.includes("://")) {
      const parsed = parseStorageUrl(photo);
      if (parsed.bucket && parsed.path) {
        pushTarget(parsed.bucket, parsed.path);
      }
    } else if (fallbackBucket) {
      pushTarget(fallbackBucket, photo);
    }
    return targets;
  }

  if (!photo || typeof photo !== "object") return targets;

  const record = photo as Record<string, unknown>;
  const storagePath = coerceString(record.storagePath);
  const downloadUrl = coerceString(record.downloadUrl) || coerceString(record.url);
  const bucketHint = coerceString(record.bucket) || coerceString(record.storageBucket) || fallbackBucket;

  if (downloadUrl) {
    const parsed = parseStorageUrl(downloadUrl);
    if (parsed.bucket && parsed.path) {
      pushTarget(parsed.bucket, parsed.path);
    }
  }

  if (storagePath && bucketHint) {
    pushTarget(bucketHint, storagePath);
  }

  return targets;
}

export async function cleanupSubmissionsAndMarkers(params: {
  locationId: string;
  submissions: Array<QueryDocumentSnapshot<DocumentData>>;
}): Promise<CleanupResult> {
  const firestore = db();
  if (params.submissions.length === 0) {
    return {
      submissionsDeleted: 0,
      markersDeleted: 0,
      usersUpdated: 0,
      locationUpdated: false,
      storageDeleted: 0,
    };
  }

  const locationRef = firestore.collection("locations").doc(params.locationId);
  const markersCol = locationRef.collection("markers");
  const usersCol = locationRef.collection("users");

  const geohashes = new Set<string>();
  const userCounts = new Map<string, number>();
  const submissionRefs: DocumentReference[] = [];
  const storageTargets = new Map<string, { bucket: string; path: string }>();
  const fallbackBucket = resolveStorageBucket();

  for (const docSnap of params.submissions) {
    submissionRefs.push(docSnap.ref);
    const data = docSnap.data() as Record<string, unknown>;
    const geohash = coerceString(data.geohash);
    if (geohash) geohashes.add(geohash);

    const createdByUserId = coerceString(data.createdByUserId);
    if (createdByUserId) {
      userCounts.set(createdByUserId, (userCounts.get(createdByUserId) ?? 0) + 1);
    }

    const photoTargets = collectStorageTargets(data.photo, fallbackBucket);
    for (const target of photoTargets) {
      const key = `${target.bucket}/${target.path}`;
      if (!storageTargets.has(key)) storageTargets.set(key, target);
    }
  }

  if (storageTargets.size > 0) {
    const storage = getAdminApp().storage();
    for (const target of storageTargets.values()) {
      try {
        await storage.bucket(target.bucket).file(target.path).delete({ ignoreNotFound: true });
      } catch (err) {
        console.warn("[cleanup] storage delete failed", {
          bucket: target.bucket,
          path: target.path,
          err: String(err),
        });
      }
    }
  }

  let usersUpdated = 0;
  const userRefs = Array.from(userCounts.keys()).map((uid) => usersCol.doc(uid));
  const existingUserIds = new Set<string>();
  if (userRefs.length > 0) {
    const userSnaps = await firestore.getAll(...userRefs);
    userSnaps.forEach((snap) => {
      if (snap.exists) existingUserIds.add(snap.id);
    });
  }

  let locationUpdated = false;
  const locationSnap = await locationRef.get();
  const totalSubmissions = submissionRefs.length;

  const ops: Array<(batch: WriteBatch) => void> = [];

  if (locationSnap.exists && totalSubmissions > 0) {
    ops.push((batch) =>
      batch.update(locationRef, {
        activeLocationSubmisisons: FieldValue.increment(-totalSubmissions),
      })
    );
    locationUpdated = true;
  }

  for (const [userId, count] of userCounts.entries()) {
    if (!existingUserIds.has(userId)) continue;
    const ref = usersCol.doc(userId);
    ops.push((batch) =>
      batch.update(ref, {
        activeUserSubmisisons: FieldValue.increment(-count),
      })
    );
    usersUpdated += 1;
  }

  for (const geohash of geohashes) {
    ops.push((batch) => batch.delete(markersCol.doc(geohash)));
  }

  for (const ref of submissionRefs) {
    ops.push((batch) => batch.delete(ref));
  }

  const BATCH_LIMIT = 450;
  let batch = firestore.batch();
  let opCount = 0;
  for (const op of ops) {
    op(batch);
    opCount += 1;
    if (opCount >= BATCH_LIMIT) {
      await batch.commit();
      batch = firestore.batch();
      opCount = 0;
    }
  }
  if (opCount > 0) {
    await batch.commit();
  }

  return {
    submissionsDeleted: submissionRefs.length,
    markersDeleted: geohashes.size,
    usersUpdated,
    locationUpdated,
    storageDeleted: storageTargets.size,
  };
}
