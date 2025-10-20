// src/app/invite/join/page.tsx
"use client";

import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { getFirebaseAuth } from "@/lib/firebaseClient";
import { createUserWithEmailAndPassword, updateProfile } from "firebase/auth";

/**
 * Invitation join page.
 *
 * When a driver receives an invitation they are directed to this page via a
 * special URL containing their email, the sub-account location ID and the
 * inviter's GHL user ID.  The form allows the driver to set their name and
 * password; the email is fixed and displayed read-only.  Upon submission a
 * Firebase auth account is created and the `/api/auth/complete-signup` endpoint
 * is invoked to persist the user into the application's database.  If
 * everything succeeds the user is redirected to the dashboard for their
 * location.
 */
export default function InviteJoinPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Extract query parameters.  Support multiple aliases to accommodate
  // variations in case and naming.  Default to empty strings when absent.
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
      // Create a new Firebase auth account for this email/password
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      // Update the display name to reflect the driver's real name
      try {
        await updateProfile(cred.user, {
          displayName: `${firstName.trim()} ${lastName.trim()}`.trim(),
        });
      } catch {
        /* ignore profile update errors */
      }
      // Obtain an ID token for secure backend calls
      const idToken = await cred.user.getIdToken();
      // Persist the user to Firestore via the existing API
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
      // Redirect to the dashboard with the location preselected
      const qs = new URLSearchParams();
      qs.set("location_id", locationId);
      router.push(`/app?${qs.toString()}`);
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
        {/* Hidden fields ensure the location and GHL user context is preserved
            throughout the form lifecycle.  These values are not editable but are
            present in the DOM for clarity and potential future use. */}
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
