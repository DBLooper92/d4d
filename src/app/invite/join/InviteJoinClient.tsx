// src/app/invite/join/InviteJoinClient.tsx
"use client";

import React, { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { getFirebaseAuth } from "@/lib/firebaseClient";
import { createUserWithEmailAndPassword } from "firebase/auth";

export default function InviteJoinClient() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Query params (email is read-only in the form)
  const [email, setEmail] = useState<string>("");
  const [locationId, setLocationId] = useState<string>("");
  const [ghlUserId, setGhlUserId] = useState<string>("");

  useEffect(() => {
    const e = searchParams.get("email") || "";
    const loc =
      searchParams.get("location_id") || searchParams.get("locationId") || "";
    const user =
      searchParams.get("user_id") || searchParams.get("userId") || "";
    setEmail(e);
    setLocationId(loc);
    setGhlUserId(user);
  }, [searchParams]);

  // Form state
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (busy) return;
    setError(null);

    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are required");
      return;
    }
    if (!password) {
      setError("Password is required");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    setBusy(true);
    try {
      const auth = getFirebaseAuth();
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      const idToken = await cred.user.getIdToken();

      // Persist user profile + link to location + GHL user
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
          ghlLocationId: locationId || null,
        }),
      });

      const data = (await resp.json()) as { ok?: boolean; error?: string };
      if (!resp.ok || data.error) {
        throw new Error(data.error || `HTTP_${resp.status}`);
      }

      const qs = new URLSearchParams();
      if (locationId) qs.set("location_id", locationId);
      router.push(`/app?${qs.toString()}`);
    } catch (err: unknown) {
      let msg = "Something went wrong";
      if (err instanceof Error && err.message) msg = err.message;
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card p-4 grid gap-4" onSubmit={handleSubmit}>
      {error ? <div className="text-red-600 text-sm">{error}</div> : null}

      <div className="form-control">
        <label className="label">
          <span className="label-text">Email</span>
        </label>
        <input type="email" className="input input-bordered" value={email} readOnly />
      </div>

      <div className="form-control">
        <label className="label">
          <span className="label-text">First Name</span>
        </label>
        <input
          type="text"
          className="input input-bordered"
          value={firstName}
          onChange={(ev: React.ChangeEvent<HTMLInputElement>) =>
            setFirstName(ev.target.value)
          }
          required
        />
      </div>

      <div className="form-control">
        <label className="label">
          <span className="label-text">Last Name</span>
        </label>
        <input
          type="text"
          className="input input-bordered"
          value={lastName}
          onChange={(ev: React.ChangeEvent<HTMLInputElement>) =>
            setLastName(ev.target.value)
          }
          required
        />
      </div>

      <div className="form-control">
        <label className="label">
          <span className="label-text">Password</span>
        </label>
        <input
          type="password"
          className="input input-bordered"
          value={password}
          onChange={(ev: React.ChangeEvent<HTMLInputElement>) =>
            setPassword(ev.target.value)
          }
          required
        />
      </div>

      <div className="form-control">
        <label className="label">
          <span className="label-text">Confirm Password</span>
        </label>
        <input
          type="password"
          className="input input-bordered"
          value={confirm}
          onChange={(ev: React.ChangeEvent<HTMLInputElement>) =>
            setConfirm(ev.target.value)
          }
          required
        />
      </div>

      <button type="submit" className="btn primary" disabled={busy}>
        {busy ? "Creating Account..." : "Join"}
      </button>
    </form>
  );
}
