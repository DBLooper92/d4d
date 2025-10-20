// src/components/invites/InviteList.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";

type GhlUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

type LocationUsersResponse =
  | { users?: GhlUser[] }
  | { data?: { users?: GhlUser[] } }
  | { error?: { message?: string } };

type InviteDriverRequest = {
  locationId: string;
  userId: string;
  userEmail: string;
  userName?: string | null;
};

type InviteDriverResponse =
  | { ok: true; joinUrl: string }
  | { ok?: false; error: string }
  | { error: string };

type InviteState = {
  loading: boolean;
  error?: string;
  joinUrl?: string;
};

type InviteListProps = {
  /** Optional locationId from the page. If absent, this component will read it from the URL. */
  locationId?: string;
};

function pickLikelyLocationIdFromUrl(url: URL): string {
  const fromQS =
    url.searchParams.get("location_id") ||
    url.searchParams.get("locationId") ||
    "";
  if (fromQS && fromQS.trim()) return fromQS.trim();

  const hash = url.hash || "";
  if (hash) {
    try {
      const h = hash.startsWith("#") ? hash.slice(1) : hash;
      const asParams = new URLSearchParams(h);
      const fromHash =
        asParams.get("location_id") || asParams.get("locationId") || "";
      if (fromHash && fromHash.trim()) return fromHash.trim();
    } catch {
      /* ignore */
    }
  }
  return "";
}

export default function InviteList({ locationId: locationIdProp }: InviteListProps) {
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [items, setItems] = useState<GhlUser[]>([]);
  const [inviteStatus, setInviteStatus] = useState<Record<string, InviteState>>(
    {},
  );

  const locationId = useMemo(() => {
    if (locationIdProp) return locationIdProp;
    if (typeof window === "undefined") return "";
    return pickLikelyLocationIdFromUrl(new URL(window.location.href));
  }, [locationIdProp]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setErr(null);
      try {
        const qs = new URLSearchParams();
        if (locationId) qs.set("location_id", locationId);

        const r = await fetch(`/api/ghl/location-users?${qs.toString()}`, {
          method: "GET",
          headers: { "Cache-Control": "no-store" },
        });

        const data = (await r.json()) as LocationUsersResponse;

        if (!r.ok) {
          throw new Error(`Failed to load users (HTTP_${r.status})`);
        }
        if ("error" in data && data.error?.message) {
          throw new Error(data.error.message);
        }

        // Normalize list safely for TS
        let list: GhlUser[] = [];
        if ("users" in data && Array.isArray(data.users)) {
          list = data.users;
        } else if ("data" in data && data.data?.users && Array.isArray(data.data.users)) {
          list = data.data.users;
        }

        if (!cancelled) setItems(list ?? []);
      } catch (e: unknown) {
        const msg =
          e instanceof Error && e.message
            ? e.message
            : "Failed to load users.";
        if (!cancelled) setErr(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  async function handleInvite(u: GhlUser) {
    if (!u?.id) return;

    setInviteStatus((prev) => ({
      ...prev,
      [u.id]: { loading: true, error: undefined, joinUrl: undefined },
    }));

    try {
      const payload: InviteDriverRequest = {
        locationId,
        userId: u.id,
        userEmail: (u.email ?? "").trim(),
        userName: u.name ?? null,
      };

      const resp = await fetch("/api/invite-driver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await resp.json()) as InviteDriverResponse;

      if (!resp.ok || "error" in data) {
        const msg =
          ("error" in data && data.error) ||
          `Invite failed (HTTP_${resp.status})`;
        throw new Error(msg);
      }

      setInviteStatus((prev) => ({
        ...prev,
        [u.id]: { loading: false, joinUrl: data.joinUrl },
      }));
    } catch (e: unknown) {
      const msg =
        e instanceof Error && e.message ? e.message : "Failed to send invite.";
      setInviteStatus((prev) => ({
        ...prev,
        [u.id]: { loading: false, error: msg },
      }));
    }
  }

  if (loading) {
    return (
      <div className="p-4">
        <div className="text-sm text-gray-600">Loading users…</div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="p-4">
        <div className="text-sm text-red-600">Error: {err}</div>
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="p-4">
        <div className="text-sm text-gray-600">No users found for this location.</div>
      </div>
    );
  }

  return (
    <div className="p-4 grid gap-3">
      {items.map((u) => {
        const s = inviteStatus[u.id] || { loading: false };
        const disabled = s.loading || !u.email;

        return (
          <div key={u.id} className="card p-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium truncate">
                {u.name || "(no name)"}{" "}
                <span className="text-xs text-gray-500">#{u.id}</span>
              </div>
              <div className="text-sm text-gray-600 truncate">
                {u.email || "no-email@unknown"}
              </div>
              {u.role ? (
                <div className="text-xs text-gray-500 mt-0.5">
                  Role: {u.role}
                </div>
              ) : null}
              {s.error ? (
                <div className="text-xs text-red-600 mt-2">
                  Invite failed: {s.error}
                </div>
              ) : null}
              {s.joinUrl ? (
                <div className="mt-2">
                  <div className="text-xs text-gray-700">
                    Join URL (copy to test):
                  </div>
                  <input
                    className="input input-bordered w-full mt-1"
                    value={s.joinUrl}
                    readOnly
                    onFocus={(ev: React.FocusEvent<HTMLInputElement>) =>
                      ev.currentTarget.select()
                    }
                  />
                </div>
              ) : null}
            </div>

            <button
              className="btn primary shrink-0"
              disabled={disabled}
              onClick={() => void handleInvite(u)}
              title={u.email ? "Send invite" : "No email available"}
            >
              {s.loading ? "Inviting…" : "Invite"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
