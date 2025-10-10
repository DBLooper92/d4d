// src/components/auth/RequireLocationAuth.tsx
"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, type Auth } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebaseClient";
import AuthClient from "./AuthClient";

export default function RequireLocationAuth({
  children,
}: {
  children: React.ReactNode;
}) {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [uid, setUid] = useState<string | null>(null);

  useEffect(() => {
    const a = getFirebaseAuth();
    setAuth(a);
    const unsub = onAuthStateChanged(a, (u) => setUid(u ? u.uid : null));
    return () => unsub();
  }, []);

  if (!auth) {
    return (
      <main className="p-6 max-w-3xl mx-auto">
        <section className="hero card">
          <h1 className="text-2xl font-semibold">Loading...</h1>
          <p className="text-gray-600 mt-1">Preparing authentication...</p>
        </section>
      </main>
    );
  }

  // If no user, show the sign in / register flow (it will keep the location_id and redirect on success)
  if (!uid) {
    return <AuthClient />;
  }

  // Authenticated → render the intended page
  return <>{children}</>;
}
