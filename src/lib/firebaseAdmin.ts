// File: src/lib/firebaseAdmin.ts
import * as admin from "firebase-admin";

let app: admin.app.App | undefined;
let firestore: admin.firestore.Firestore | undefined;

function resolveEnv(name: string, fallbackName: string): string | undefined {
  const primary = process.env[name];
  if (primary && primary.trim().length > 0) {
    return primary;
  }
  const fallback = process.env[fallbackName];
  return fallback && fallback.trim().length > 0 ? fallback : undefined;
}

export function getAdminApp(): admin.app.App {
  if (!app) {
    // In Firebase App Hosting, ADC is available. Prefer explicit credentials if set.
    if (admin.apps.length) {
      app = admin.app();
    } else {
      const projectId = resolveEnv("FIREBASE_ADMIN_PROJECT_ID", "FIREBASE_PROJECT_ID");
      const clientEmail = resolveEnv("FIREBASE_ADMIN_CLIENT_EMAIL", "FIREBASE_CLIENT_EMAIL");
      const rawPrivateKey = resolveEnv("FIREBASE_ADMIN_PRIVATE_KEY", "FIREBASE_PRIVATE_KEY");

      if (projectId && clientEmail && rawPrivateKey) {
        app = admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey: rawPrivateKey.replace(/\\n/g, "\n"),
          }),
        });
      } else {
        app = admin.initializeApp(); // Application Default Credentials
      }
    }
  }
  return app!;
}

export function getAdminFirestore(): admin.firestore.Firestore {
  if (!firestore) {
    firestore = getAdminApp().firestore();
  }
  return firestore;
}

export function db(): admin.firestore.Firestore {
  return getAdminFirestore();
}
