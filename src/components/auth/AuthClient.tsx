// src/components/auth/AuthClient.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  type Auth,
} from "firebase/auth";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { getFirebaseAuth } from "@/lib/firebaseClient";
import { DASHBOARD_ROUTE } from "@/lib/routes";

type SsoContext = {
  activeLocationId?: string | null;
  activeCompanyId?: string | null;
  userId?: string | null;
  userName?: string | null;
  email?: string | null;
  type?: string | null;
};

type EncryptedPayloadObject = { iv: string; cipherText: string; tag: string };
type EncryptedAny = string | EncryptedPayloadObject;

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
    }, 5000);

    try {
      window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*");
      const onMsg = (ev: MessageEvent<unknown>) => {
        const data = ev?.data as unknown;
        if (isObj(data) && data["message"] === "REQUEST_USER_DATA_RESPONSE") {
          const mm = data as MarketplaceMessage;
          const maybe =
            "encryptedData" in mm ? (mm.encryptedData as unknown)
            : "payload" in mm ? (mm.payload as unknown)
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
    return (await r.json()) as SsoContext;
  } catch {
    return null;
  }
}

function pickLikelyLocationId(url: URL) {
  const search = url.searchParams;
  const fromQS = search.get("location_id") || search.get("locationId") || search.get("location") || "";
  if (fromQS && fromQS.trim()) return fromQS.trim();

  const hash = url.hash || "";
  if (hash) {
    try {
      const h = hash.startsWith("#") ? hash.slice(1) : hash;
      const asParams = new URLSearchParams(h);
      const fromHash = asParams.get("location_id") || asParams.get("locationId") || asParams.get("location") || "";
      if (fromHash && fromHash.trim()) return fromHash.trim();
    } catch {}
  }
  return "";
}

type Mode = "login" | "register";

function visibleError(code: string): string {
  const c = code.toLowerCase();
  if (c.includes("invalid-email")) return "That email looks invalid.";
  if (c.includes("user-not-found") || c.includes("wrong-password")) return "Email or password is incorrect.";
  if (c.includes("email-already-in-use")) return "That email is already registered.";
  if (c.includes("weak-password")) return "Password should be at least 6 characters.";
  return "Something went wrong. Please try again.";
}

function buildDashboardHref(qs: URLSearchParams): string {
  const query = qs.toString();
  return query ? `${DASHBOARD_ROUTE}?${query}` : DASHBOARD_ROUTE;
}

export default function AuthClient() {
  const router = useRouter();
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

  /**
   * Hold the HighLevel SSO context if available.
   *
   * On mount we request the encrypted user context from the parent frame (GHL)
   * and decode it server‑side via `/api/user-context/decode`.  Storing it in
   * state ensures that repeated calls don’t re‑issue the postMessage request
   * unnecessarily and provides synchronous access when the user clicks
   * Register.  If the user opens the app outside of GHL, this will remain
   * null and fallbacks (email matching) apply.
   */
  const [ssoContext, setSsoContext] = useState<SsoContext | null>(null);

  useEffect(() => {
    // Fetch the marketplace user context once when the component mounts.  The
    // helper returns null if no context is available or if decryption fails.
    (async () => {
      try {
        const ctx = await getMarketplaceUserContext();
        setSsoContext(ctx);
      } catch {
        // ignore; will remain null
      }
    })();
  }, []);

  const contextFromUrl = useMemo(() => {
    if (typeof window === "undefined") return { locationId: "" };
    const u = new URL(window.location.href);
    return { locationId: pickLikelyLocationId(u) };
  }, []);

  // Redirect when signed in
  useEffect(() => {
    if (!auth) return;
    const unsub = onAuthStateChanged(auth, (u) => {
      if (u) {
        setUid(u.uid);
        setUserEmail(u.email || null);
        const url = new URL(window.location.href);
        const loc = pickLikelyLocationId(url);
        const qs = new URLSearchParams();
        if (loc) qs.set("location_id", loc);
        router.replace(buildDashboardHref(qs) as unknown as Route);
      } else {
        setUid(null);
        setUserEmail(null);
      }
    });
    return () => unsub();
  }, [auth, router]);

  // Best-effort enhancement: if locationId missing, try SSO (some CMLs auto-provide it)
  useEffect(() => {
    (async () => {
      if (contextFromUrl.locationId || typeof window === "undefined") return;
      // Prefer the cached SSO context if available.  If not present, fetch
      // just once on demand.  This avoids multiple calls to the marketplace
      // context helper and mitigates race conditions.
      const sso = ssoContext ?? (await getMarketplaceUserContext());
      if (sso?.activeLocationId) {
        const url = new URL(window.location.href);
        url.searchParams.set("location_id", sso.activeLocationId);
        window.history.replaceState({}, "", url.toString());
      }
    })();
  }, [contextFromUrl.locationId, ssoContext]);

  async function handleRegister() {
    setErr(null);
    if (!auth) { setErr("Auth not ready yet. Please try again."); return; }
    if (!email.trim() || !password.trim() || !firstName.trim() || !lastName.trim()) {
      setErr("Please fill in all fields."); return;
    }
    if (password !== confirm) { setErr("Passwords do not match."); return; }
    setBusy(true);
    try {
      // Determine the active location ID from the URL or the SSO context.  When
      // running inside the HighLevel marketplace, the SSO context includes
      // `activeLocationId` which we can trust.  Avoid requesting the context
      // multiple times by using the cached value if present.
      let { locationId } = contextFromUrl;
      const sso = ssoContext ?? (await getMarketplaceUserContext());
      locationId = locationId || sso?.activeLocationId || "";
      if (!locationId) {
        throw new Error("We couldn't detect your Location ID. Open from your sub-account custom menu.");
      }
      // Capture identifiers returned by HighLevel's SSO context so the server
      // can persist them without additional API lookups.
      const ghlUserId = sso?.userId ?? null;
      const ghlCompanyId = sso?.activeCompanyId ?? null;
      const ghlLocationId = sso?.activeLocationId ?? null;
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      const idToken = await cred.user.getIdToken(true);
      const resp = await fetch("/api/auth/complete-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          email: email.trim(),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          agencyId: null,
          locationId,
          ghlUserId,
          ghlCompanyId,
          ghlLocationId,
        }),
      });
      if (!resp.ok) {
        const parsed = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(parsed?.error || `Signup finalize failed (${resp.status})`);
      }
      const qs = new URLSearchParams();
      qs.set("location_id", locationId);
      router.replace(buildDashboardHref(qs) as unknown as Route);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.toLowerCase().includes("firebase:") ? visibleError(msg) : msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin() {
    setErr(null);
    if (!auth) { setErr("Auth not ready yet. Please try again."); return; }
    if (!email.trim() || !password.trim()) { setErr("Please enter your email and password."); return; }
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
      <main className="p-6 max-w-3xl mx-auto">
        <section className="hero card">
          <h1 className="text-2xl font-semibold">Loading...</h1>
          <p className="text-gray-600 mt-1">Preparing authentication...</p>
        </section>
      </main>
    );
  }

  if (uid) {
    return (
      <main className="p-6 max-w-3xl mx-auto">
        <section className="card">
          <h1 className="text-xl font-semibold">Welcome back</h1>
          <p className="mt-2 text-gray-700">
            Redirecting to your dashboard... {userEmail ? <span className="badge">{userEmail}</span> : null}
          </p>
          <div className="mt-6 flex items-center gap-3">
            <button onClick={handleSignOut} disabled={busy} className="btn">
              {busy ? "Signing you out..." : "Sign out"}
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="p-6 max-w-5xl mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
        <div className="md:col-span-2">
          <section className="hero card">
            <h1 className="text-2xl font-semibold">Driving for Dollars</h1>
            <p className="text-gray-600 mt-1">Sign in or create an admin account to get started.</p>
            <ul className="text-sm text-gray-600 mt-3" style={{ listStyle: "disc", paddingLeft: "1.25rem" }}>
              <li>Open from your sub-account custom menu so <code>location_id</code> is auto-passed</li>
              <li>After signup/login you&apos;re routed to the Dashboard</li>
            </ul>
          </section>
        </div>

        <div className="md:col-span-3">
          <section className="card">
<div className="mb-4 inline-flex rounded-xl border overflow-hidden">
  <button
    className={`px-4 py-2 ${mode === "login" ? "bg-gray-50" : ""}`}
    onClick={() => { setMode("login"); setErr(null); }}
    type="button"
  >
    Login
  </button>
  <button
    className={`px-4 py-2 ${mode === "register" ? "bg-gray-50" : ""}`}
    onClick={() => { setMode("register"); setErr(null); }}
    type="button"
  >
    Register
  </button>
</div>



            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (mode === "login") void handleLogin();
                else void handleRegister();
              }}
              className="space-y-4"
            >
              {mode === "register" && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm mb-1">First name</label>
                    <input value={firstName} onChange={(ev) => setFirst(ev.target.value)} className="input" required />
                  </div>
                  <div>
                    <label className="block text-sm mb-1">Last name</label>
                    <input value={lastName} onChange={(ev) => setLast(ev.target.value)} className="input" required />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm mb-1">Email</label>
                <input type="email" value={email} onChange={(ev) => setEmail(ev.target.value)} className="input" required />
              </div>

              <div>
                <label className="block text-sm mb-1">Password</label>
                <input type="password" value={password} onChange={(ev) => setPassword(ev.target.value)} className="input" required minLength={6} />
              </div>

              {mode === "register" && (
                <div>
                  <label className="block text-sm mb-1">Confirm password</label>
                  <input type="password" value={confirm} onChange={(ev) => setConfirm(ev.target.value)} className="input" required minLength={6} />
                </div>
              )}

              {err && <p className="text-sm text-red-600">{err}</p>}

              <button type="submit" disabled={busy} className="btn primary w-full">
                {busy ? (mode === "login" ? "Logging in..." : "Creating account...") : (mode === "login" ? "Login" : "Register")}
              </button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
