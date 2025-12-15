"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  type Auth,
} from "firebase/auth";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import logoImage from "../../../images/logo.png";
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

// A UI step representing the current stage of the auth flow.
type UiStep = "select" | "register" | "login";

// Slim user shape for the “Get Users by Location” list
type GhlUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

type ApiOk = { users?: GhlUser[] } | { data?: { users?: GhlUser[] } };
type ApiErr = { error?: { code?: string; message?: string } };

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

  // Step state
  const [step, setStep] = useState<UiStep>("select");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  // User list for the location
  const [users, setUsers] = useState<GhlUser[]>([]);
  const [usersLoading, setUsersLoading] = useState<boolean>(false);
  const [usersErr, setUsersErr] = useState<string | null>(null);

  // Form state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [uid, setUid] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // SSO context (if running inside GHL)
  const [ssoContext, setSsoContext] = useState<SsoContext | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const ctx = await getMarketplaceUserContext();
        setSsoContext(ctx);
      } catch {
        /* ignore */
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

  // Fill in missing location_id from SSO if available
  useEffect(() => {
    (async () => {
      if (contextFromUrl.locationId || typeof window === "undefined") return;
      const sso = ssoContext ?? (await getMarketplaceUserContext());
      if (sso?.activeLocationId) {
        const url = new URL(window.location.href);
        url.searchParams.set("location_id", sso.activeLocationId);
        window.history.replaceState({}, "", url.toString());
      }
    })();
  }, [contextFromUrl.locationId, ssoContext]);

  // Handlers to move between steps
  function handleSelectUser(userId: string) {
    setErr(null);
    setSelectedUserId(userId);
    if (typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("ghl_user_id", userId);
        window.history.replaceState({}, "", url.toString());
      } catch {}
    }
    setStep("register");
  }
  function handleBackToSelect() {
    setErr(null);
    if (typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("ghl_user_id");
        window.history.replaceState({}, "", url.toString());
      } catch {}
    }
    setSelectedUserId(null);
    setStep("select");
  }
  function handleGoToLogin() {
    setErr(null);
    if (typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("ghl_user_id");
        window.history.replaceState({}, "", url.toString());
      } catch {}
    }
    setSelectedUserId(null);
    setStep("login");
  }
  function handleLoginBack() {
    setErr(null);
    setStep("select");
  }

  // Preselect from ?ghl_user_id
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const sp = new URLSearchParams(window.location.search);
      const suid = sp.get("ghl_user_id");
      if (suid && suid.trim()) {
        setSelectedUserId(suid.trim());
        setStep("register");
      }
    } catch {}
  }, []);

  // Load users when on the selection step
  useEffect(() => {
    if (step !== "select") return;
    let cancelled = false;
    (async () => {
      setUsersLoading(true);
      setUsersErr(null);
      try {
        const loc = contextFromUrl.locationId || ssoContext?.activeLocationId || "";
        if (!loc) {
          setUsersErr("We couldn't detect your Location ID. Open the app from your sub-account custom menu.");
          setUsers([]);
          return;
        }
        const resp = await fetch(`/api/ghl/location-users?location_id=${encodeURIComponent(loc)}`, {
          headers: { "Cache-Control": "no-store" },
        });
        const text = await resp.text();
        let parsed: ApiOk & ApiErr;
        try {
          parsed = JSON.parse(text) as ApiOk & ApiErr;
        } catch {
          throw new Error(`Non-JSON from API (${resp.status})`);
        }
        if (!resp.ok || parsed.error) {
          const code = parsed.error?.code || `HTTP_${resp.status}`;
          const msg = parsed.error?.message || "Failed to load users.";
          throw new Error(`${code}: ${msg}`);
        }
        const list = ("users" in parsed && parsed.users) || ("data" in parsed && parsed.data?.users) || [];
        if (!cancelled) setUsers(Array.isArray(list) ? list : []);
      } catch (e) {
        if (!cancelled) {
          setUsersErr(e instanceof Error ? e.message : String(e));
          setUsers([]);
        }
      } finally {
        if (!cancelled) setUsersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, contextFromUrl.locationId, ssoContext]);

  const accentColor = "#01B9FA";
  const accentBorder = "#bae6fd";
  const heroGradient = "linear-gradient(135deg, #f0f9ff 0%, #f8fafc 50%, #ffffff 100%)";
  const mainBg =
    "radial-gradient(circle at 12% 20%, #e0f2fe 0, rgba(224,242,254,0) 26%), radial-gradient(circle at 85% 10%, #e2e8f0 0, rgba(226,232,240,0) 20%), #ffffff";

  async function handleRegister() {
    setErr(null);
    if (!auth) { setErr("Auth not ready yet. Please try again."); return; }
    if (!email.trim() || !password.trim() || !firstName.trim() || !lastName.trim()) { setErr("Please fill in all fields."); return; }
    if (password !== confirm) { setErr("Passwords do not match."); return; }
    setBusy(true);
    try {
      if (!selectedUserId) {
        setErr("Please select a HighLevel user before registering.");
        setBusy(false);
        return;
      }
      // location id from URL or SSO
      let { locationId } = contextFromUrl;
      const sso = ssoContext ?? (await getMarketplaceUserContext());
      locationId = locationId || sso?.activeLocationId || "";
      if (!locationId) throw new Error("We couldn't detect your Location ID. Open from your sub-account custom menu.");

      // IDs to persist
      const ghlUserId = selectedUserId ?? null;
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

  // ----- Renders -----

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

  if (step === "select") {
    return (
      <main
        className="p-6 min-h-screen"
        style={{ background: mainBg }}
      >
        <div className="max-w-4xl mx-auto">
          <section
            className="card"
            style={{
              background: heroGradient,
              borderColor: accentBorder,
              boxShadow: "0 14px 40px rgba(1,185,250,0.14)",
              padding: "1.5rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <Image
                  src={logoImage}
                  alt="Driving4Dollars.co logo"
                  width={42}
                  height={42}
                  style={{ objectFit: "contain", filter: "drop-shadow(0 10px 22px rgba(1,185,250,0.25))" }}
                />
                <div style={{ display: "grid", gap: "2px" }}>
                  <span style={{ fontWeight: 800, color: "#0f172a", letterSpacing: "0.01em" }}>Driving4Dollars.co</span>
                  <span style={{ color: "#0284c7", fontWeight: 700, fontSize: "0.9rem" }}>Owner access</span>
                </div>
              </div>
              <button
                type="button"
                onClick={handleGoToLogin}
                className="btn primary"
                style={{
                  background: accentColor,
                  borderColor: accentColor,
                  color: "#fff",
                  fontWeight: 800,
                  boxShadow: "0 8px 16px rgba(1,185,250,0.24)",
                  minWidth: "150px",
                }}
              >
                Sign in instead
              </button>
            </div>

            <div style={{ marginTop: "14px", display: "grid", gap: "10px" }}>
              <div style={{ fontSize: "1.35rem", fontWeight: 800, color: "#0f172a" }}>
                Choose the owner for this location
              </div>
              <p style={{ color: "#475569", margin: 0 }}>
                Pick the person who should manage this Location in Driving for Dollars. They control invites, settings and they can view all submissions.
              </p>
            </div>

            <div className="mt-5 grid gap-3">
              {usersLoading ? (
                <div className="grid gap-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="card" style={{ borderColor: "#e2e8f0", padding: "0.85rem" }}>
                      <div className="skel" style={{ height: 18, width: "45%" }} />
                      <div className="skel" style={{ height: 12, width: "30%", marginTop: "6px" }} />
                    </div>
                  ))}
                </div>
              ) : usersErr ? (
                <div className="card" style={{ borderColor: "#fecdd3", background: "#fff1f2" }}>
                  <div className="text-red-700 font-medium">Couldn&apos;t load users for this sub-account.</div>
                  <div className="text-sm text-red-600 mt-1">{usersErr}</div>
                  <div className="text-xs text-gray-500 mt-2">
                    Tip: open from the Location custom menu so we can read the location users.
                  </div>
                </div>
              ) : !users.length ? (
                <div className="card" style={{ borderColor: "#e2e8f0", background: "#f8fafc" }}>
                  No HighLevel users returned for this sub-account. Add a user in HighLevel, then reopen this app.
                </div>
              ) : (
                <div className="grid gap-2">
                  {users.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => handleSelectUser(u.id)}
                      className="card text-left cursor-pointer w-full hover:shadow-lg hover:-translate-y-0.5 transition"
                      style={{
                        borderColor: "#e2e8f0",
                        padding: "0.85rem 1rem",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        transition: "box-shadow 0.15s ease, transform 0.1s ease, border-color 0.15s ease",
                      }}
                    >
                      <div style={{ display: "grid", gap: "2px" }}>
                        <div style={{ fontWeight: 700, color: "#0f172a" }}>{u.name || u.email || "(unnamed user)"}</div>
                        {u.email ? (
                          <div style={{ color: "#475569", fontSize: "0.95rem" }}>{u.email}</div>
                        ) : null}
                        {u.role ? (
                          <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>Role: {u.role}</div>
                        ) : null}
                      </div>
                      <span
                        className="badge"
                        style={{ borderColor: accentBorder, background: "#0ea5e9", color: "#fff", fontWeight: 800 }}
                      >
                        Choose
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    );
  }

  if (step === "login") {
    return (
      <main
        className="p-6 min-h-screen"
        style={{ background: mainBg }}
      >
        <div className="max-w-4xl mx-auto">
          <section
            className="card"
            style={{
              background: heroGradient,
              borderColor: accentBorder,
              boxShadow: "0 14px 40px rgba(1,185,250,0.14)",
              padding: "1.5rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <Image
                  src={logoImage}
                  alt="Driving4Dollars.co logo"
                  width={42}
                  height={42}
                  style={{ objectFit: "contain", filter: "drop-shadow(0 10px 22px rgba(1,185,250,0.25))" }}
                />
                <div style={{ display: "grid", gap: "2px" }}>
                  <span style={{ fontWeight: 800, color: "#0f172a", letterSpacing: "0.01em" }}>Driving4Dollars.co</span>
                  <span style={{ color: "#0284c7", fontWeight: 700, fontSize: "0.9rem" }}>Owner sign-in</span>
                </div>
              </div>
              <button
                type="button"
                onClick={handleLoginBack}
                className="btn"
                style={{
                  borderColor: "#e2e8f0",
                  fontWeight: 700,
                  color: "#0f172a",
                  background: "#fff",
                }}
              >
                &larr; Back
              </button>
            </div>

            <div style={{ marginTop: "14px", display: "grid", gap: "10px" }}>
              <div style={{ fontSize: "1.35rem", fontWeight: 800, color: "#0f172a" }}>
                Sign in as the location owner
              </div>
              <p style={{ color: "#475569", margin: 0 }}>
                Use the owner login you set for this Location. Once signed in, you can invite drivers and manage billing.
              </p>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleLogin();
              }}
              className="space-y-4"
              style={{ marginTop: "16px" }}
            >
              <div>
                <label className="block text-sm mb-1 font-semibold text-slate-800">Owner email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(ev) => setEmail(ev.target.value)}
                  className="input"
                  required
                  placeholder="you@yourbusiness.com"
                />
              </div>
              <div>
                <label className="block text-sm mb-1 font-semibold text-slate-800">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(ev) => setPassword(ev.target.value)}
                  className="input"
                  required
                  minLength={6}
                  placeholder="Enter your password"
                />
              </div>
              {err && <p className="text-sm text-red-600">{err}</p>}
              <button
                type="submit"
                disabled={busy}
                className="btn primary w-full"
                style={{
                  background: accentColor,
                  borderColor: accentColor,
                  color: "#fff",
                  fontWeight: 800,
                  boxShadow: "0 10px 24px rgba(1,185,250,0.24)",
                }}
              >
                {busy ? "Logging in..." : "Sign in"}
              </button>
            </form>

            <div style={{ marginTop: "12px", color: "#64748b", fontSize: "0.9rem" }}>
              Drivers get invited from inside the dashboard after you sign in.
            </div>
          </section>
        </div>
      </main>
    );
  }

  // default: register
  return (
    <main
      className="p-6 min-h-screen"
      style={{ background: mainBg }}
    >
      <div className="max-w-4xl mx-auto">
        <section
          className="card"
          style={{
            background: heroGradient,
            borderColor: accentBorder,
            boxShadow: "0 14px 40px rgba(1,185,250,0.14)",
            padding: "1.5rem",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Image
                src={logoImage}
                alt="Driving4Dollars.co logo"
                width={42}
                height={42}
                style={{ objectFit: "contain", filter: "drop-shadow(0 10px 22px rgba(1,185,250,0.25))" }}
              />
              <div style={{ display: "grid", gap: "2px" }}>
                <span style={{ fontWeight: 800, color: "#0f172a", letterSpacing: "0.01em" }}>Driving4Dollars.co</span>
                <span style={{ color: "#0284c7", fontWeight: 700, fontSize: "0.9rem" }}>Owner setup</span>
              </div>
            </div>
            <button
              type="button"
              onClick={handleBackToSelect}
              className="btn"
              style={{
                borderColor: "#e2e8f0",
                fontWeight: 700,
                color: "#0f172a",
                background: "#fff",
              }}
            >
              &larr; Back
            </button>
          </div>

          <div style={{ marginTop: "14px", display: "grid", gap: "10px" }}>
            <div style={{ fontSize: "1.35rem", fontWeight: 800, color: "#0f172a" }}>
              Create the owner account
            </div>
            <p style={{ color: "#475569", margin: 0 }}>
              All fields are required. This account manages drivers, billing, and settings for this HighLevel sub-account.
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleRegister();
            }}
            className="space-y-4"
            style={{ marginTop: "16px" }}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm mb-1 font-semibold text-slate-800">First name *</label>
                <input value={firstName} onChange={(ev) => setFirst(ev.target.value)} className="input" required />
              </div>
              <div>
                <label className="block text-sm mb-1 font-semibold text-slate-800">Last name *</label>
                <input value={lastName} onChange={(ev) => setLast(ev.target.value)} className="input" required />
              </div>
            </div>
            <div>
              <label className="block text-sm mb-1 font-semibold text-slate-800">Email *</label>
              <input type="email" value={email} onChange={(ev) => setEmail(ev.target.value)} className="input" required />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm mb-1 font-semibold text-slate-800">Password *</label>
                <input
                  type="password"
                  value={password}
                  onChange={(ev) => setPassword(ev.target.value)}
                  className="input"
                  required
                  minLength={6}
                  placeholder="At least 6 characters"
                />
              </div>
              <div>
                <label className="block text-sm mb-1 font-semibold text-slate-800">Confirm password *</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(ev) => setConfirm(ev.target.value)}
                  className="input"
                  required
                  minLength={6}
                />
              </div>
            </div>
            {err && <p className="text-sm text-red-600">{err}</p>}
            <button
              type="submit"
              disabled={busy}
              className="btn primary w-full"
              style={{
                background: accentColor,
                borderColor: accentColor,
                color: "#fff",
                fontWeight: 800,
                boxShadow: "0 10px 24px rgba(1,185,250,0.24)",
              }}
            >
              {busy ? "Creating account..." : "Create owner account"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
