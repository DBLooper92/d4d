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
  const [checked, setChecked] = useState(false); // NEW: have we resolved initial auth?

  useEffect(() => {
    const a = getFirebaseAuth();
    setAuth(a);
    const unsub = onAuthStateChanged(a, (u) => {
      setUid(u ? u.uid : null);
      setChecked(true);
    });
    return () => unsub();
  }, []);

  // Still initializing Firebase or haven't resolved initial auth state yet
  if (!auth || !checked) {
    return (
      <main className="p-6 max-w-3xl mx-auto">
        <section className="hero card">
          <h1 className="text-2xl font-semibold">Loading...</h1>
          <p className="text-gray-600 mt-1">Preparing authentication...</p>
        </section>
      </main>
    );
  }

  // Initial auth resolved: if not signed in, show login/register
  if (!uid) {
    return <AuthClient />;
  }

  // Signed in → render the intended page without redirecting away
  return <>{children}</>;
}
