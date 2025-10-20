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
          <button className="btn primary" type="button" onClick={() => {/* no-op for now */}}>
            Invite
          </button>
        </div>
      ))}
    </div>
  );
}
