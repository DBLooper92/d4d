// File: src/lib/firebaseAdmin.ts
// Server-only Firebase Admin bootstrap with singletons.
// Exports both a `getDb()` function and ready `db`, `Timestamp`, `FieldValue`
// so existing and new code paths are covered.

import * as admin from "firebase-admin";

// Handles both ADC (Cloud Run / Firebase Hosting) and explicit SA creds (local)
function initAdminApp(): admin.app.App {
  if (admin.apps.length) return admin.app();

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && rawKey) {
    // Replace escaped newlines if key comes from env
    const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;

    return admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  }

  // Fall back to ADC (Application Default Credentials)
  return admin.initializeApp();
}

// Singleton app
let _app: admin.app.App | undefined;
export function getAdminApp(): admin.app.App {
  if (!_app) _app = initAdminApp();
  return _app;
}

// Function form (for existing callers)
export function getDb(): admin.firestore.Firestore {
  return getAdminApp().firestore();
}

// Ready-to-use instance exports (for new code)
export const adminApp = getAdminApp();
export const db = adminApp.firestore();
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;
