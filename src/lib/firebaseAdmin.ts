// src/lib/firebaseAdmin.ts
// Server-only Firebase Admin bootstrap with singletons.
// Exports both a `db()` function (legacy style) and an instance `dbInstance`,
// plus `Timestamp` and `FieldValue`.

import * as admin from "firebase-admin";

function initAdminApp(): admin.app.App {
  if (admin.apps.length) return admin.app();

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && rawKey) {
    const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
    return admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
  }
  return admin.initializeApp(); // ADC
}

let _app: admin.app.App | undefined;
export function getAdminApp(): admin.app.App {
  if (!_app) _app = initAdminApp();
  return _app;
}

// Function form (legacy-friendly): most of your code calls db()
export function db(): admin.firestore.Firestore {
  return getAdminApp().firestore();
}

// Keep a named instance available for code that prefers property-style usage
export const dbInstance = getAdminApp().firestore();

export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;

// Optional: still expose getDb() for any older imports
export function getDb(): admin.firestore.Firestore {
  return db();
}
