// src/components/invites/InviteList.tsx
"use client";

import { useEffect, useState } from "react";

type GhlUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

type ApiOk = { users?: GhlUser[] } | { data?: { users?: GhlUser[] } };
type ApiErr = { error?: { code?: string; message?: string } };

export default function InviteList({ locationId }: { locationId: string }) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [items, setItems] = useState<GhlUser[]>([]);

  /**
   * Track invite state for each user. The key is the user ID and the value
   * reflects whether an invite is currently being sent, has been sent, or
   * encountered an error. This allows the UI to display per‑row status and
   * prevent duplicate submissions.
   */
  const [inviteState, setInviteState] = useState<
    Record<string, { sending: boolean; sent: boolean; error?: string | null }>
  >({});

  async function handleInvite(u: GhlUser) {
    // Ensure we have an email; inviting without an email is not supported.
    if (!u.email) {
      setInviteState((prev) => ({
        ...prev,
        [u.id]: { sending: false, sent: false, error: "No email available" },
      }));
      return;
    }
    // Optimistically mark as sending.
    setInviteState((prev) => ({
      ...prev,
      [u.id]: { sending: true, sent: false, error: null },
    }));
    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId, email: u.email, firstName: u.name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        const msg = data.error?.message || res.statusText;
        throw new Error(msg || "Failed to send invite");
      }
      setInviteState((prev) => ({
        ...prev,
        [u.id]: { sending: false, sent: true, error: null },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setInviteState((prev) => ({
        ...prev,
        [u.id]: { sending: false, sent: false, error: msg },
      }));
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const r = await fetch(`/api/ghl/location-users?location_id=${encodeURIComponent(locationId)}`, {
          headers: { "Cache-Control": "no-store" },
        });
        const text = await r.text();
        let parsed: ApiOk & ApiErr;
        try {
          parsed = JSON.parse(text) as ApiOk & ApiErr;
        } catch {
          throw new Error(`Non-JSON from API (${r.status})`);
        }

        if (!r.ok || parsed.error) {
          const code = parsed.error?.code || `HTTP_${r.status}`;
          const msg = parsed.error?.message || "Failed to load users.";
          throw new Error(`${code}: ${msg}`);
        }

        const list =
          (("users" in parsed && parsed.users) ||
            ("data" in parsed && parsed.data?.users) ||
            []) as unknown;

        if (!cancelled) setItems(Array.isArray(list) ? list : []);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locationId]);

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
    <div className="grid gap-2">
      {items.map((u) => (
        <div key={u.id} className="card flex items-center justify-between">
          <div>
            <div className="font-medium">{u.name || u.email || "(unnamed user)"}</div>
            <div className="text-xs text-gray-500 mt-1">GHL User ID: {u.id}</div>
            {u.email ? <div className="text-xs text-gray-500">{u.email}</div> : null}
          </div>
          <div className="flex flex-col items-end">
            <button
              className="btn primary"
              type="button"
              disabled={inviteState[u.id]?.sending || inviteState[u.id]?.sent}
              onClick={() => handleInvite(u)}
            >
              {inviteState[u.id]?.sending
                ? "Sending..."
                : inviteState[u.id]?.sent
                ? "Sent"
                : "Invite"}
            </button>
            {inviteState[u.id]?.error ? (
              <div className="text-xs text-red-600 mt-1 w-40 text-right break-words">
                {inviteState[u.id]?.error}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
