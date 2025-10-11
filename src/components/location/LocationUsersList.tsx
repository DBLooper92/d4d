// src/components/location/LocationUsersList.tsx
"use client";

import { useEffect, useMemo, useState } from "react";

type UserRow = {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
};

export default function LocationUsersList({ locationId }: { locationId: string }) {
  const [items, setItems] = useState<UserRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const qs = useMemo(() => new URLSearchParams({ location_id: locationId }).toString(), [locationId]);

  useEffect(() => {
    let ignore = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const r = await fetch(`/api/ghl/location-users?${qs}`, { headers: { "Cache-Control": "no-store" } });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error || `Query failed (${r.status})`);
        }
        const j = (await r.json()) as { items: UserRow[] };
        if (!ignore) setItems(j.items || []);
      } catch (e) {
        if (!ignore) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [qs]);

  if (loading) {
    return (
      <section className="mt-4 grid gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card flex items-center justify-between">
            <div className="skel" style={{ height: 18, width: "40%" }} />
            <div className="skel" style={{ height: 34, width: 100 }} />
          </div>
        ))}
      </section>
    );
  }

  if (err) {
    return (
      <section className="mt-4 card" style={{ borderColor: "#fecaca" }}>
        <p className="text-red-600">{err}</p>
      </section>
    );
  }

  if (!items || items.length === 0) {
    return (
      <section className="mt-4 card">
        <p className="text-gray-700">No users found for this location.</p>
      </section>
    );
  }

  return (
    <section className="mt-4 grid gap-2">
      {items.map((u) => (
        <div key={u.id} className="card flex items-center justify-between">
          <div>
            <div className="font-medium">
              {u.name}{" "}
              <span className="text-xs text-gray-500">[{u.id}]</span>
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {u.email ? u.email : "(no email)"} {u.role ? `• ${u.role}` : ""}
            </div>
          </div>
          <button className="btn">Invite</button>
        </div>
      ))}
    </section>
  );
}
