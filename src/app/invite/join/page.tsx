// src/app/invite/join/page.tsx
"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getFirebaseAuth } from "@/lib/firebaseClient";
import { createUserWithEmailAndPassword, updateProfile } from "firebase/auth";

export const dynamic = "force-dynamic";

/**
 * Inner client component that reads search params and handles registration.
 * Wrapped by a Suspense boundary in the default export to satisfy
 * useSearchParams() CSR bailout requirements.
 */
function InviteJoinInner() {
  const searchParams = useSearchParams();

  // Extract query parameters
  const email = searchParams.get("email")?.toString() || "";
  const locationId =
    searchParams.get("location_id")?.toString() ||
    searchParams.get("locationId")?.toString() ||
    "";
  const ghlUserId =
    searchParams.get("user_id")?.toString() ||
    searchParams.get("ghl_user_id")?.toString() ||
    "";

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!firstName.trim() || !lastName.trim()) {
      setError("Please enter your first and last name.");
      return;
    }
    if (password.length < 6) {
      setError("Password should be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (!email || !locationId) {
      setError("Invalid invitation link. Missing required details.");
      return;
    }

    setLoading(true);
    try {
      const auth = getFirebaseAuth();

      // Create account
      const cred = await createUserWithEmailAndPassword(auth, email, password);

      // Best-effort profile update
      try {
        await updateProfile(cred.user, {
          displayName: `${firstName.trim()} ${lastName.trim()}`.trim(),
        });
      } catch {
        /* ignore */
      }

      // Persist to backend
      const idToken = await cred.user.getIdToken();
      const resp = await fetch("/api/auth/complete-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          email,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          locationId,
          ghlUserId: ghlUserId || null,
        }),
      });

      if (!resp.ok) {
        const data = (await resp.json().catch(() => null)) as { error?: string } | null;
        const msg = data?.error || `Signup failed (${resp.status})`;
        throw new Error(msg);
      }

      // Hard redirect to external dashboard domain after successful registration
      window.location.assign("https://app.driving4dollars.co/dashboard");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || "Failed to create account. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="p-6 max-w-lg mx-auto">
      <h1 className="text-2xl font-semibold">Join Driving for Dollars</h1>
      <p className="text-gray-600 mt-1">
        Complete the form below to finish setting up your account.
      </p>

      <form className="mt-4 grid gap-3" onSubmit={handleSubmit}>
        {/* Hidden fields to preserve context */}
        <input type="hidden" name="locationId" value={locationId} readOnly />
        <input type="hidden" name="ghlUserId" value={ghlUserId} readOnly />

        <div>
          <label className="block text-sm font-medium">Email</label>
          <input type="email" value={email} readOnly className="input w-full bg-gray-100" />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-sm font-medium">First Name</label>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="input w-full"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Last Name</label>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="input w-full"
              required
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input w-full"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium">Confirm Password</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="input w-full"
            required
          />
        </div>

        {error ? <div className="text-sm text-red-600">{error}</div> : null}

        <button type="submit" className="btn primary" disabled={loading}>
          {loading ? "Creating Account..." : "Join"}
        </button>
      </form>
    </main>
  );
}

export default function InviteJoinPage() {
  return (
    <Suspense fallback={<main className="p-6 max-w-lg mx-auto">Loading…</main>}>
      <InviteJoinInner />
    </Suspense>
  );
}
