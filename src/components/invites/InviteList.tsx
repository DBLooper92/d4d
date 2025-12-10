// src/components/invites/InviteList.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebaseClient";

type GhlUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

type ManagedUser = GhlUser & { active: boolean; isAdmin: boolean };

type ManageResp = {
  users: ManagedUser[];
  activeLimit: number;
  activeCount: number;
  adminGhlUserId: string | null;
  error?: string;
};

export default function InviteList({ locationId }: { locationId: string }) {
  const auth = useMemo(() => getFirebaseAuth(), []);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [items, setItems] = useState<ManagedUser[]>([]);
  const [activeLimit, setActiveLimit] = useState<number>(5);
  const [activeCount, setActiveCount] = useState<number>(0);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // Track the state of invitations keyed by GHL user ID.  Each entry
  // indicates whether an invite is pending, completed or failed and stores the
  // generated join URL when available.
  const [inviteState, setInviteState] = useState<Record<string, { status: string; joinUrl?: string; error?: string }>>({});

  /**
   * Send an invite to a particular user.  This calls our API route which
   * upserts the contact, tags it, sends the email and returns a join URL.
   */
  async function sendInvite(u: GhlUser) {
    const userId = u.id;
    if (!userId) return;
    setInviteState((prev) => ({ ...prev, [userId]: { status: "loading" } }));
    try {
      const res = await fetch("/api/invite-driver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId,
          email: u.email ?? "",
          name: u.name ?? null,
          ghlUserId: userId,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(txt || `Invite failed (${res.status})`);
      }
      const data = (await res.json()) as { joinUrl?: string; contactId?: string };
      const joinUrl = data.joinUrl || "";
      // Store the join URL and mark success.  Also copy the link to the
      // clipboard when available to simplify testing; ignore errors if the
      // clipboard API is unavailable (e.g. in some browsers).
      setInviteState((prev) => ({
        ...prev,
        [userId]: { status: "success", joinUrl },
      }));
      if (joinUrl) {
        try {
          await navigator.clipboard.writeText(joinUrl);
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setInviteState((prev) => ({
        ...prev,
        [userId]: { status: "error", error: msg },
      }));
    }
  }

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setAuthUser(u);
      setAuthReady(true);
    });
    return () => unsub();
  }, [auth]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!authReady) return;
      if (!authUser) {
        setErr("Not signed in.");
        setLoading(false);
        return;
      }
      setLoading(true);
      setErr(null);
      try {
        const idToken = await authUser.getIdToken(true);
        const r = await fetch(`/api/location-users/manage?location_id=${encodeURIComponent(locationId)}`, {
          headers: { Authorization: `Bearer ${idToken}`, "Cache-Control": "no-store" },
        });
        const parsed = (await r.json().catch(() => ({}))) as ManageResp;
        if (!r.ok || parsed.error) {
          throw new Error(parsed.error || `Failed to load users (${r.status})`);
        }
        if (!Array.isArray(parsed.users)) throw new Error("Unexpected response shape.");
        if (!cancelled) {
          setItems(parsed.users);
          setActiveLimit(parsed.activeLimit ?? 5);
          setActiveCount(parsed.activeCount ?? 0);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authReady, authUser, locationId]);

  async function toggleActive(user: ManagedUser) {
    if (user.isAdmin) return; // admin always active
    const userId = user.id;
    const next = !user.active;
    setSavingId(userId);
    setBanner(null);
    const prev = items;
    setItems((list) => list.map((u) => (u.id === userId ? { ...u, active: next } : u)));
    try {
      if (!authUser) throw new Error("Not signed in.");
      const idToken = await authUser.getIdToken(true);
      const res = await fetch("/api/location-users/manage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ locationId, ghlUserId: userId, active: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; activeCount?: number; activeLimit?: number };
      if (!res.ok || data.error) {
        if (data.error === "ACTIVE_LIMIT_REACHED") {
          throw new Error(`Limit reached. Only ${data.activeLimit ?? activeLimit} drivers can be active at once.`);
        }
        throw new Error(data.error || `Update failed (${res.status})`);
      }
      setActiveCount(data.activeCount ?? activeCount);
      setActiveLimit(data.activeLimit ?? activeLimit);
    } catch (e) {
      setItems(prev);
      setBanner(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  }

  if (loading) {
    return (
      <div className="grid gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="card">
            <div className="skel" style={{ height: 20, width: "50%" }} />
          </div>
        ))}
      </div>
    );
  }

  if (err) {
    return (
      <div className="card" style={{ borderColor: "#fecaca" }}>
        <div className="text-red-700 font-medium">Couldn&apos;t load sub-account users</div>
        <div className="text-sm text-red-600 mt-1">{err}</div>
        <div className="text-xs text-gray-500 mt-2">
          Tip: ensure the location has a valid refresh token in Firestore and that the marketplace app has <code>users.readonly</code>.
        </div>
      </div>
    );
  }

  if (!items.length) {
    return <div className="card">No users returned for this location.</div>;
  }

  return (
    <div className="grid gap-3">
      <div className="card flex items-center justify-between">
        <div>
          <div className="font-semibold">Active drivers</div>
          <div className="text-sm text-gray-600">Up to {activeLimit} drivers plus the admin can be active.</div>
        </div>
        <div className="text-sm text-gray-700">
          {activeCount} / {activeLimit} active
        </div>
      </div>
      {banner ? <div className="card" style={{ borderColor: "#fecaca", color: "#b91c1c" }}>{banner}</div> : null}
      {items.map((u) => {
        const state = inviteState[u.id || ""];
        const inviting = state?.status === "loading";
        const inviteSent = state?.status === "success";
        const inviteError = state?.status === "error" ? state.error : null;
        const toggleDisabled = savingId === u.id || u.isAdmin;
        const isActive = u.isAdmin ? true : u.active;
        return (
          <div key={u.id} className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
            <div style={{ display: "grid", gap: "0.15rem" }}>
              <div className="font-medium flex items-center gap-2">
                <span>{u.name || u.email || "(unnamed user)"}</span>
                {u.isAdmin ? <span className="badge badge-muted">Admin</span> : null}
              </div>
              <div className="text-xs text-gray-500">GHL User ID: {u.id}</div>
              {u.email ? <div className="text-xs text-gray-500">{u.email}</div> : null}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <div style={{ textAlign: "right" }}>
                {inviteSent ? (
                  <div className="text-xs text-green-700 font-medium">Invite sent</div>
                ) : inviteError ? (
                  <div className="text-xs text-red-600">Error: {inviteError}</div>
                ) : (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => sendInvite(u)}
                    disabled={inviting}
                  >
                    {inviting ? "Sending..." : "Invite"}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => toggleActive(u)}
                disabled={toggleDisabled}
                aria-pressed={isActive}
                aria-label={isActive ? "Set inactive" : "Set active"}
                style={{
                  position: "relative",
                  width: "60px",
                  height: "32px",
                  borderRadius: "999px",
                  border: "1px solid #e2e8f0",
                  background: isActive ? "#dcfce7" : "#e5e7eb",
                  padding: 0,
                  cursor: toggleDisabled ? "not-allowed" : "pointer",
                  transition: "background-color 150ms ease, box-shadow 150ms ease",
                  boxShadow: isActive ? "0 0 0 4px rgba(34,197,94,0.12)" : "none",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: "4px",
                    left: isActive ? "32px" : "4px",
                    width: "24px",
                    height: "24px",
                    borderRadius: "999px",
                    background: isActive ? "#16a34a" : "#cbd5e1",
                    boxShadow: "0 2px 6px rgba(0,0,0,0.14)",
                    transition: "left 150ms ease, background-color 150ms ease",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <span
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "999px",
                      background: isActive ? "#15803d" : "#94a3b8",
                    }}
                  />
                </span>
              </button>
              <div className="text-xs text-gray-600" style={{ minWidth: "70px", textAlign: "right" }}>
                {u.isAdmin ? "Active (admin)" : isActive ? "Active" : "Inactive"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
