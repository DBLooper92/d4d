// File: src/lib/firebaseAdmin.ts
import * as admin from "firebase-admin";

let app: admin.app.App | undefined;

export function getAdminApp(): admin.app.App {
  if (!app) {
    // In Firebase App Hosting, ADC is available. If running locally,
    // you can set FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY to init.
    if (admin.apps.length) {
      app = admin.app();
    } else if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      app = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      });
    } else {
      app = admin.initializeApp(); // ADC
    }
  }
  return app!;
}

export function db(): admin.firestore.Firestore {
  return getAdminApp().firestore();
}
