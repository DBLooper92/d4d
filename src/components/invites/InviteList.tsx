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
  phone?: string | null;
};

type ManagedUser = GhlUser & {
  active: boolean;
  isAdmin: boolean;
  invited: boolean;
  inviteStatus?: string;
  invitedAt?: string | null;
  firebaseUid?: string | null;
  accepted: boolean;
};

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
      setItems((prev) =>
        prev.map((m) => (m.id === userId ? { ...m, invited: true, inviteStatus: "invited" } : m)),
      );
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
        const r = await fetch(`/api/location-users/manage?location_id=${encodeURIComponent(locationId)}&idToken=${encodeURIComponent(idToken)}`, {
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
    if (!user.accepted) {
      setBanner("User must accept the invite before activation.");
      return;
    }
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
        body: JSON.stringify({ locationId, ghlUserId: userId, active: next, idToken }),
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
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card" style={{ padding: "14px 16px" }}>
            <div className="skel" style={{ height: 18, width: "38%" }} />
            <div className="skel" style={{ height: 14, width: "64%", marginTop: "8px" }} />
          </div>
        ))}
      </div>
    );
  }

  if (err) {
    return (
      <div className="card" style={{ borderColor: "#fecaca", background: "#fff1f2" }}>
        <div className="font-medium" style={{ color: "#b91c1c" }}>Couldn&apos;t load drivers</div>
        <div className="text-sm" style={{ color: "#b91c1c", marginTop: "4px" }}>{err}</div>
        <div className="text-xs" style={{ color: "#9f1239", marginTop: "6px" }}>
          Tip: ensure the location has a valid refresh token in Firestore and that the marketplace app has <code>users.readonly</code>.
        </div>
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="card" style={{ padding: "16px" }}>
        <div className="font-medium" style={{ color: "#0f172a" }}>No drivers yet</div>
        <div className="text-sm" style={{ color: "#475569", marginTop: "4px" }}>
          Add users in HighLevel for this sub-account, then send invites here.
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div
        className="card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          padding: "14px 16px",
          background: "#f8fafc",
          borderColor: "#e2e8f0",
        }}
      >
        <div style={{ display: "grid", gap: "4px" }}>
          <div className="text-sm" style={{ color: "#0f172a", fontWeight: 700 }}>Driver access</div>
          <div className="text-sm" style={{ color: "#475569" }}>
            Admin is always active. {activeLimit} driver slots available.
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontWeight: 700, color: "#0f172a", fontSize: "1.1rem" }}>
            {activeCount} / {activeLimit}
          </div>
          <div style={{ color: "#475569", fontSize: "0.9rem" }}>Active drivers</div>
        </div>
      </div>
      {banner ? <div className="card" style={{ borderColor: "#fee2e2", background: "#fef2f2", color: "#b91c1c" }}>{banner}</div> : null}
      <div className="grid gap-2">
        {items.map((u) => {
          const state = inviteState[u.id || ""];
          const inviting = state?.status === "loading";
          const inviteSent = state?.status === "success" || u.invited;
          const inviteError = state?.status === "error" ? state.error : null;
          const toggleDisabled = savingId === u.id || u.isAdmin || !u.accepted;
          const isActive = u.isAdmin ? true : u.active;
          const showInviteButton = !u.firebaseUid && !u.isAdmin;
          const inviteLabel = u.invited ? "Resend invite" : "Send invite";
          const primary = u.name || u.email || "Unnamed user";
          const badgeData = [
            u.isAdmin ? { label: "Admin", bg: "#e0f2fe", fg: "#0f172a" } : null,
            u.accepted
              ? { label: "Joined", bg: "#dcfce7", fg: "#166534" }
              : { label: u.invited ? "Invite sent" : "Invite pending", bg: "#fef3c7", fg: "#92400e" },
            { label: isActive ? "Active" : "Inactive", bg: isActive ? "#dcfce7" : "#e2e8f0", fg: isActive ? "#166534" : "#475569" },
          ].filter(Boolean) as Array<{ label: string; bg: string; fg: string }>;
          const initials = (primary || "D").trim().slice(0, 1).toUpperCase() || "D";
          return (
            <div
              key={u.id}
              className="card"
              style={{
                padding: "14px 16px",
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto",
                gap: "12px",
                alignItems: "center",
              }}
            >
              <div style={{ display: "grid", gap: "8px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div
                    aria-hidden="true"
                    style={{
                      width: "42px",
                      height: "42px",
                      borderRadius: "12px",
                      background: "linear-gradient(135deg, #e0f2fe, #bfdbfe)",
                      display: "grid",
                      placeItems: "center",
                      color: "#1d4ed8",
                      fontWeight: 800,
                      fontSize: "1rem",
                      boxShadow: "0 10px 20px rgba(37,99,235,0.18)",
                    }}
                  >
                    {initials}
                  </div>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <div style={{ fontWeight: 700, color: "#0f172a" }}>{primary}</div>
                    {u.email ? <div style={{ color: "#475569", fontSize: "0.92rem" }}>{u.email}</div> : null}
                    {u.phone ? <div style={{ color: "#0f172a", fontSize: "0.92rem", fontWeight: 600 }}>{u.phone}</div> : null}
                    {!u.email && !u.phone ? (
                      <div style={{ color: "#94a3b8", fontSize: "0.9rem" }}>No contact info on file</div>
                    ) : null}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  {badgeData.map((b) => (
                    <span
                      key={b.label}
                      className="badge"
                      style={{
                        background: b.bg,
                        color: b.fg,
                        borderColor: `${b.fg}22`,
                        fontWeight: 700,
                      }}
                    >
                      {b.label}
                    </span>
                  ))}
                  {inviteSent && showInviteButton ? (
                    <span className="text-xs" style={{ color: "#16a34a", fontWeight: 700 }}>Invite sent</span>
                  ) : null}
                  {inviteError ? (
                    <span className="text-xs" style={{ color: "#b91c1c", fontWeight: 700 }}>Invite failed</span>
                  ) : null}
                </div>
              </div>
              <div style={{ display: "grid", gap: "8px", justifyItems: "end" }}>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", justifyContent: "flex-end" }}>
                  {showInviteButton ? (
                    <button
                      className="btn primary"
                      type="button"
                      onClick={() => sendInvite(u)}
                      disabled={inviting}
                      style={{ padding: "8px 12px" }}
                    >
                      {inviting ? "Sending..." : inviteLabel}
                    </button>
                  ) : inviteSent ? (
                    <span className="text-xs" style={{ color: "#16a34a", fontWeight: 700 }}>Invite sent</span>
                  ) : null}
                </div>
                {inviteError ? (
                  <div className="text-xs" style={{ color: "#b91c1c", maxWidth: "240px", textAlign: "right" }}>
                    {inviteError}
                  </div>
                ) : null}
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: "0.85rem", color: "#475569", fontWeight: 600 }}>
                      {u.isAdmin
                        ? "Admin always active"
                        : u.accepted
                          ? isActive
                            ? "Active in dashboard"
                            : "Inactive in dashboard"
                          : "Awaiting join"}
                    </div>
                    {!u.accepted ? (
                      <div style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Enable after they join</div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleActive(u)}
                    disabled={toggleDisabled}
                    aria-pressed={isActive}
                    aria-label={isActive ? "Set inactive" : "Set active"}
                    style={{
                      position: "relative",
                      width: "66px",
                      height: "34px",
                      borderRadius: "999px",
                      border: "1px solid #e2e8f0",
                      background: isActive ? "#dcfce7" : "#e5e7eb",
                      padding: 0,
                      cursor: toggleDisabled ? "not-allowed" : "pointer",
                      transition: "background-color 150ms ease, box-shadow 150ms ease",
                      boxShadow: isActive ? "0 0 0 4px rgba(34,197,94,0.16)" : "none",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        top: "4px",
                        left: isActive ? "34px" : "4px",
                        width: "26px",
                        height: "26px",
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
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
