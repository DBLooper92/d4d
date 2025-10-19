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

  // Track invite status and generated join URLs per user. When a user is
  // invited successfully, we store the joinUrl so it can be displayed and
  // avoid multiple invite attempts.
  const [inviteStatus, setInviteStatus] = useState<Record<string, { loading: boolean; joinUrl?: string; error?: string }>>({});

  /**
   * Handle inviting a driver. Posts to our API to upsert the contact, tag it and
   * send an email. On success the API returns a joinUrl which we store. Errors
   * are captured in the status so the UI can inform the user.
   */
  async function inviteUser(u: GhlUser) {
    const userId = u.id;
    if (!userId) return;
    setInviteStatus((prev) => ({ ...prev, [userId]: { loading: true } }));
    try {
      const body = {
        locationId,
        userId: u.id,
        userEmail: u.email ?? "",
        userName: u.name ?? null,
      };
      const r = await fetch("/api/invite-driver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (!r.ok || (parsed && typeof parsed === "object" && parsed.error)) {
        const msg = (parsed && typeof parsed === "object" && parsed.error) || `HTTP_${r.status}`;
        setInviteStatus((prev) => ({ ...prev, [userId]: { loading: false, error: String(msg) } }));
        return;
      }
      const joinUrl = parsed?.joinUrl ?? null;
      setInviteStatus((prev) => ({ ...prev, [userId]: { loading: false, joinUrl: joinUrl || undefined } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setInviteStatus((prev) => ({ ...prev, [userId]: { loading: false, error: msg } }));
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
            {inviteStatus[u.id]?.joinUrl ? (
              <div className="mt-2">
                <div className="text-xs text-green-700 mb-1">Invite sent! Copy the join link:</div>
                <input
                  type="text"
                  className="input input-bordered w-full text-xs"
                  readOnly
                  value={inviteStatus[u.id]?.joinUrl || ""}
                  onFocus={(ev) => ev.currentTarget.select()}
                />
              </div>
            ) : null}
            {inviteStatus[u.id]?.error ? (
              <div className="mt-2 text-xs text-red-600">{inviteStatus[u.id]?.error}</div>
            ) : null}
          </div>
          <button
            className="btn primary"
            type="button"
            disabled={inviteStatus[u.id]?.loading}
            onClick={() => inviteUser(u)}
          >
            {inviteStatus[u.id]?.loading
              ? "Inviting..."
              : inviteStatus[u.id]?.joinUrl
                ? "Invited"
                : "Invite"}
          </button>
        </div>
      ))}
    </div>
  );
}
