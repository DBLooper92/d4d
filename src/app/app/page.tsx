"use client";

import { useEffect, useMemo, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  type Auth,
} from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebaseClient";

type SsoContext = {
  activeLocationId?: string | null;
  activeCompanyId?: string | null;
  userId?: string | null;
  role?: string | null;
  type?: string | null;
  userName?: string | null;
  email?: string | null;
};

// Accept both formats: single AES string OR object {iv,cipherText,tag}
type EncryptedPayloadObject = { iv: string; cipherText: string; tag: string };
type EncryptedAny = string | EncryptedPayloadObject;

// HL has shipped both of these keys:
//   - { message: "REQUEST_USER_DATA_RESPONSE", encryptedData: ... }
//   - { message: "REQUEST_USER_DATA_RESPONSE", payload: ... }
type MarketplaceMessage =
  | { message: "REQUEST_USER_DATA_RESPONSE"; encryptedData: EncryptedAny }
  | { message: "REQUEST_USER_DATA_RESPONSE"; payload: EncryptedAny };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function getMarketplaceUserContext(): Promise<SsoContext | null> {
  const encrypted = await new Promise<EncryptedAny | null>((resolve) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) resolve(null);
    }, 3000);

    try {
      // Ask parent (GHL) for the encrypted user context
      window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*");

      const onMsg = (ev: MessageEvent<unknown>) => {
        const data = ev?.data as unknown;

        if (isObj(data) && data["message"] === "REQUEST_USER_DATA_RESPONSE") {
          const mm = data as MarketplaceMessage;

          const maybe =
            "encryptedData" in mm
              ? (mm.encryptedData as unknown)
              : "payload" in mm
              ? (mm.payload as unknown)
              : null;

          const okString = typeof maybe === "string" && !!maybe;
          const okObj =
            isObj(maybe) &&
            typeof (maybe as EncryptedPayloadObject).iv === "string" &&
            typeof (maybe as EncryptedPayloadObject).cipherText === "string" &&
            typeof (maybe as EncryptedPayloadObject).tag === "string";

          if (okString || okObj) {
            done = true;
            clearTimeout(timeout);
            window.removeEventListener("message", onMsg as EventListener);
            resolve(maybe as EncryptedAny);
            return;
          }
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

function pickLikelyLocationId(url: URL) {
  const search = url.searchParams;
  const fromQS =
    search.get("location_id") ||
    search.get("locationId") ||
    search.get("location") ||
    "";
  if (fromQS && fromQS.trim()) return fromQS.trim();

  const hash = url.hash || "";
  if (hash) {
    try {
      const h = hash.startsWith("#") ? hash.slice(1) : hash;
      const asParams = new URLSearchParams(h);
      const fromHash =
        asParams.get("location_id") ||
        asParams.get("locationId") ||
        asParams.get("location") ||
        "";
      if (fromHash && fromHash.trim()) return fromHash.trim();
      const segs = h.split(/[/?&]/).filter(Boolean);
      const maybeId = segs.find((s) => s.length >= 12);
      if (maybeId) return maybeId.trim();
    } catch {
      /* ignore */
    }
  }

  const segs = url.pathname.split("/").filter(Boolean);
  const maybeId = segs.length >= 2 ? segs[1] : "";
  if (maybeId && maybeId.length >= 12) return maybeId.trim();

  return "";
}
function pickLikelyAgencyId(url: URL) {
  const search = url.searchParams;
  const fromQS =
    search.get("agency_id") || search.get("agencyId") || search.get("companyId") || "";
  return (fromQS || "").trim();
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
  const [auth, setAuth] = useState<Auth | null>(null);
  useEffect(() => {
    setAuth(getFirebaseAuth());
  }, []);

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

  const contextFromUrl = useMemo(() => {
    if (typeof window === "undefined") return { locationId: "", agencyId: "" };
    const u = new URL(window.location.href);
    return { locationId: pickLikelyLocationId(u), agencyId: pickLikelyAgencyId(u) };
  }, []);

  useEffect(() => {
    if (!auth) return;
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

  // If we don't have locationId from URL, try to patch URL from SSO on load.
  useEffect(() => {
    (async () => {
      if (contextFromUrl.locationId || typeof window === "undefined") return;
      const sso = await getMarketplaceUserContext();
      if (sso?.activeLocationId) {
        const url = new URL(window.location.href);
        url.searchParams.set("location_id", sso.activeLocationId);
        if (sso.activeCompanyId) url.searchParams.set("agencyId", sso.activeCompanyId);
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
    if (!auth) {
      setErr("Auth not ready yet. Please try again.");
      return;
    }
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
      // 1) Gather Marketplace SSO FIRST so we don’t miss GHL identity fields
      let { locationId, agencyId } = contextFromUrl;
      const sso = await getMarketplaceUserContext();
      locationId = locationId || sso?.activeLocationId || "";
      agencyId = agencyId || sso?.activeCompanyId || "";

      if (!locationId) {
        throw new Error(
          "We couldn't detect your Location ID. Please open this app from your GHL custom menu (it includes the location_id automatically)."
        );
      }

      // 2) Create Firebase user
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      const idToken = await cred.user.getIdToken(/* forceRefresh */ true);

      // 3) Finalize profile in Firestore with strict GHL identity hints
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
          // GHL identity context (null-safe)
          ghlUserId: sso?.userId ?? null,
          ghlRole: sso?.role ?? null,
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
    if (!auth) {
      setErr("Auth not ready yet. Please try again.");
      return;
    }
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
      if (auth) await signOut(auth);
    } catch {
      setErr("Sign out failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!auth) {
    return (
      <main className="p-6 max-w-md mx-auto">
        <h1 className="text-2xl font-semibold mb-4">Loading…</h1>
        <p className="text-gray-600">Preparing authentication…</p>
      </main>
    );
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
          Tip: open this from your GHL custom menu so the <code>location_id</code> is auto-passed.
        </p>
      </form>
    </main>
  );
}
