// src/lib/firebaseClient.ts
import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

function required(name: string): string {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required client env: ${name}`);
  }
  return String(v);
}

let app: FirebaseApp | undefined;

export function getFirebaseApp(): FirebaseApp {
  if (!app) {
    app =
      getApps()[0] ??
      initializeApp({
        apiKey: required("NEXT_PUBLIC_FIREBASE_API_KEY"),
        authDomain: required("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
        projectId: required("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
        appId: required("NEXT_PUBLIC_FIREBASE_APP_ID"),
      });
  }
  return app!;
}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp());
}
