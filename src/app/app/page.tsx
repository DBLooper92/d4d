// src/app/app/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebaseClient";

type SsoContext = {
  activeLocationId?: string;
  activeCompanyId?: string;
  userId?: string;
  role?: string;
  type?: string;
  userName?: string;
  email?: string;
};

type EncryptedPayload = { iv: string; cipherText: string; tag: string };
type RequestUserDataResponse = { message: "REQUEST_USER_DATA_RESPONSE"; payload: EncryptedPayload };

function pickFromAliases(search: URLSearchParams, keys: string[]): string {
  for (const k of keys) {
    const v = search.get(k);
    if (v && v.trim()) return v.trim();
  }
  return "";
}

function pickLikelyLocationId(url: URL) {
  return pickFromAliases(url.searchParams, ["location_id", "locationId", "location", "subAccountId", "accountId"]);
}
function pickLikelyAgencyId(url: URL) {
  return pickFromAliases(url.searchParams, ["agency_id", "agencyId", "companyId"]);
}
function pickGhlUserId(url: URL) {
  return pickFromAliases(url.searchParams, ["ghl_user_id", "ghlUserId", "user_id", "userId"]);
}
function pickGhlRole(url: URL) {
  return pickFromAliases(url.searchParams, ["ghl_role", "ghlRole", "role"]);
}
function pickEmail(url: URL) {
  // allow testing via ?email=...
  return pickFromAliases(url.searchParams, ["email"]);
}

async function getMarketplaceUserContext(): Promise<SsoContext | null> {
  const encrypted = await new Promise<EncryptedPayload | null>((resolve) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) resolve(null);
    }, 1500);

    try {
      window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*");
      const onMsg = (ev: MessageEvent<unknown>) => {
        const d = ev?.data as RequestUserDataResponse | undefined;
        if (d && d.message === "REQUEST_USER_DATA_RESPONSE" && d.payload) {
          done = true;
          clearTimeout(timeout);
          window.removeEventListener("message", onMsg as EventListener);
          resolve(d.payload);
        }
      };
      window.addEventListener("message", onMsg as EventListener);
    } catch {
      clearTimeout(timeout);
      resolve(null);
    }
  });

  if (!encrypted) return null;

  try {
    const r = await fetch("/api/user-context/decode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encryptedData: encrypted }),
    });
    if (!r.ok) return null;
    const json = (await r.json()) as SsoContext;
    return json;
  } catch {
    return null;
  }
}

type Mode = "login" | "register";

function pickApiError(v: unknown): string | null {
  if (typeof v === "object" && v !== null) {
    const rec = v as Record<string, unknown>;
    const e = rec.error;
    if (typeof e === "string") return e;
  }
  return null;
}

export default function Page() {
  const auth = getFirebaseAuth();

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [uid, setUid] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // URL-derived context (primary)
  const contextFromUrl = useMemo(() => {
    if (typeof window === "undefined") return { locationId: "", agencyId: "", ghlUserId: "", ghlRole: "", email: "" };
    const u = new URL(window.location.href);
    return {
      locationId: pickLikelyLocationId(u),
      agencyId: pickLikelyAgencyId(u),
      ghlUserId: pickGhlUserId(u),
      ghlRole: pickGhlRole(u),
      email: pickEmail(u),
    };
  }, []);

  // When the page mounts, prefill from URL immediately (so you can test without registering)
  useEffect(() => {
    if (contextFromUrl.email) setEmail(contextFromUrl.email);
  }, [contextFromUrl.email]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (u) {
        setUid(u.uid);
        setUserEmail(u.email || null);
      } else {
        setUid(null);
        setUserEmail(null);
      }
    });
    return () => unsub();
  }, [auth]);

  // Optional: If we didn't receive location/agency via URL, attempt SSO and update the URL for persistence.
  useEffect(() => {
    (async () => {
      if (typeof window === "undefined") return;
      if (contextFromUrl.locationId && contextFromUrl.agencyId && contextFromUrl.ghlUserId && contextFromUrl.ghlRole) {
        return; // we already have full context via URL
      }
      const sso = await getMarketplaceUserContext();
      if (sso?.activeLocationId || sso?.activeCompanyId || sso?.userId || sso?.role || sso?.email) {
        const url = new URL(window.location.href);
        if (!contextFromUrl.locationId && sso.activeLocationId) url.searchParams.set("location_id", sso.activeLocationId);
        if (!contextFromUrl.agencyId && sso.activeCompanyId) url.searchParams.set("agencyId", sso.activeCompanyId);
        if (!contextFromUrl.ghlUserId && sso.userId) url.searchParams.set("ghl_user_id", sso.userId);
        if (!contextFromUrl.ghlRole && sso.role) url.searchParams.set("ghl_role", sso.role);
        if (!contextFromUrl.email && sso.email) url.searchParams.set("email", sso.email);
        window.history.replaceState({}, "", url.toString());
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function visibleError(code: string): string {
    const c = code.toLowerCase();
    if (c.includes("invalid-email")) return "That email looks invalid.";
    if (c.includes("user-not-found") || c.includes("wrong-password")) return "Email or password is incorrect.";
    if (c.includes("email-already-in-use")) return "That email is already registered.";
    if (c.includes("weak-password")) return "Password should be at least 6 characters.";
    return "Something went wrong. Please try again.";
  }

  async function handleRegister() {
    setErr(null);
    if (!email.trim() || !password.trim() || !firstName.trim() || !lastName.trim()) {
      setErr("Please fill in all fields.");
      return;
    }
    if (password !== confirm) {
      setErr("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      const idToken = await cred.user.getIdToken(true);

      // Prefer URL method, fall back to SSO (but we won't store isAgencyOwner anymore)
      let { locationId, agencyId, ghlUserId, ghlRole } = contextFromUrl;
      let sso: SsoContext | null = null;
      if (!locationId || !agencyId || !ghlUserId || !ghlRole) {
        sso = await getMarketplaceUserContext();
        locationId = locationId || sso?.activeLocationId || "";
        agencyId = agencyId || sso?.activeCompanyId || "";
        ghlUserId = ghlUserId || sso?.userId || "";
        ghlRole = ghlRole || sso?.role || "";
      }

      if (!locationId) {
        throw new Error(
          "We couldn't detect your Location ID. Please open this app from your GHL custom menu (it includes the location_id automatically).",
        );
      }

      const resp = await fetch("/api/auth/complete-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          email: email.trim(),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          agencyId: agencyId || null,
          locationId,
          ghlUserId: ghlUserId || null,
          ghlRole: ghlRole || null,
        }),
      });
      if (!resp.ok) {
        const parsed: unknown = await resp.json().catch(() => null);
        const apiError = pickApiError(parsed);
        throw new Error(apiError ?? `Signup finalize failed (${resp.status})`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.toLowerCase().includes("firebase:") ? visibleError(msg) : msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin() {
    setErr(null);
    if (!email.trim() || !password.trim()) {
      setErr("Please enter your email and password.");
      return;
    }
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(visibleError(msg));
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    setBusy(true);
    setErr(null);
    try {
      await signOut(auth);
    } catch {
      setErr("Sign out failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (uid) {
    return (
      <main className="p-6">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-2 text-gray-700">You are logged in as {userEmail || uid}.</p>

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={handleSignOut}
            disabled={busy}
            className="rounded-xl border px-4 py-2 hover:bg-gray-50 disabled:opacity-60"
          >
            {busy ? "Signing you out…" : "Sign out"}
          </button>
        </div>
      </main>
    );
  }

  const ghli = contextFromUrl.ghlUserId;
  const ghlr = contextFromUrl.ghlRole;

  return (
    <main className="p-6 max-w-md mx-auto">
      <h1 className="text-2xl font-semibold mb-4">Welcome</h1>

      <div className="mb-4 inline-flex rounded-xl border overflow-hidden">
        <button
          className={`px-4 py-2 ${mode === "login" ? "bg-gray-100" : ""}`}
          onClick={() => {
            setMode("login");
            setErr(null);
          }}
        >
          Login
        </button>
        <button
          className={`px-4 py-2 ${mode === "register" ? "bg-gray-100" : ""}`}
          onClick={() => {
            setMode("register");
            setErr(null);
          }}
        >
          Register
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === "login") {
            void handleLogin();
          } else {
            void handleRegister();
          }
        }}
        className="space-y-3"
      >
        {mode === "register" && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm mb-1">First name</label>
              <input
                value={firstName}
                onChange={(ev) => setFirst(ev.target.value)}
                className="w-full rounded-xl border px-3 py-2"
                autoComplete="given-name"
                required
              />
            </div>
            <div>
              <label className="block text-sm mb-1">Last name</label>
              <input
                value={lastName}
                onChange={(ev) => setLast(ev.target.value)}
                className="w-full rounded-xl border px-3 py-2"
                autoComplete="family-name"
                required
              />
            </div>
          </div>
        )}

        <div>
          <label className="block text-sm mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            className="w-full rounded-xl border px-3 py-2"
            autoComplete="email"
            required
          />
        </div>

        {/* New: GHL context fields (read-only, auto-populated via URL/SSO) */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm mb-1">GHL User ID</label>
            <input
              value={ghli}
              readOnly
              placeholder="(via URL)"
              className="w-full rounded-xl border px-3 py-2 bg-gray-50"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">GHL Role</label>
            <input
              value={ghlr}
              readOnly
              placeholder="(via URL)"
              className="w-full rounded-xl border px-3 py-2 bg-gray-50"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm mb-1">Password</label>
          <input
            type="password"
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            className="w-full rounded-xl border px-3 py-2"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={6}
          />
        </div>

        {mode === "register" && (
          <div>
            <label className="block text-sm mb-1">Confirm password</label>
            <input
              type="password"
              value={confirm}
              onChange={(ev) => setConfirm(ev.target.value)}
              className="w-full rounded-xl border px-3 py-2"
              autoComplete="new-password"
              required
              minLength={6}
            />
          </div>
        )}

        {err && <p className="text-sm text-red-600 mt-2">{err}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-2 w-full rounded-xl border px-4 py-2 hover:bg-gray-50 disabled:opacity-60"
        >
          {busy
            ? mode === "login"
              ? "Logging in…"
              : "Creating account…"
            : mode === "login"
              ? "Login"
              : "Register"}
        </button>

        <p className="text-xs text-gray-500 mt-3">
          Tip: open this from your GHL custom menu so the <code>location_id</code>, <code>ghl_user_id</code> and{" "}
          <code>ghl_role</code> are auto-passed.
        </p>
      </form>
    </main>
  );
}
