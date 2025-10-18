// src/components/invites/InviteList.tsx
"use client";

import { useEffect, useMemo, useState } from "react";

type GhlUser = {
  id: string; // GHL user id
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

type LocationUsersShapeA = { users?: GhlUser[] };
type LocationUsersShapeB = { data?: { users?: GhlUser[] } };
type LocationUsersResponse = LocationUsersShapeA | LocationUsersShapeB;

type InviteState = "idle" | "sending" | "sent" | "error";

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function parseUsers(payload: unknown): GhlUser[] {
  if (!isObject(payload)) return [];
  const usersA = (payload as LocationUsersShapeA).users;
  if (Array.isArray(usersA)) return usersA as GhlUser[];
  const data = (payload as LocationUsersShapeB).data;
  if (isObject(data)) {
    const usersB = (data as { users?: unknown }).users;
    if (Array.isArray(usersB)) return usersB as GhlUser[];
  }
  return [];
}

type InviteApiOk = {
  ok?: boolean;
  contactId?: string;
  inviteUrl?: string;
  sendResult?: unknown;
};
type InviteApiErr = {
  error?: unknown;
  step?: string;
  contactId?: string;
  inviteUrl?: string;
};

export default function InviteList({ locationId }: { locationId: string }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [items, setItems] = useState<GhlUser[]>([]);
  const [status, setStatus] = useState<Record<string, InviteState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<Record<string, string>>({}); // userId -> inviteUrl

  const users = useMemo<GhlUser[]>(() => {
    const list = Array.isArray(items) ? items : [];
    return list
      .filter(Boolean)
      .sort((a, b) => {
        const ax = (a.name || a.email || "").toLowerCase();
        const bx = (b.name || b.email || "").toLowerCase();
        return ax.localeCompare(bx);
      });
  }, [items]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        // POST with body (aligns with original backend behavior)
        const r = await fetch(`/api/ghl/location-users`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locationId }),
        });

        const text = await r.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as LocationUsersResponse;
        } catch {
          throw new Error(text);
        }

        if (!r.ok) {
          const message =
            (isObject(parsed) && typeof (parsed as Record<string, unknown>).error === "string"
              ? ((parsed as Record<string, string>).error as string)
              : "Failed to load users");
          throw new Error(message);
        }

        const usersArr = parseUsers(parsed);
        if (!cancelled) setItems(usersArr);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  async function handleInvite(u: GhlUser) {
    if (!u.email) {
      setErrors((prev) => ({ ...prev, [u.id]: "User has no email on file." }));
      setStatus((prev) => ({ ...prev, [u.id]: "error" }));
      return;
    }
    setErrors((prev) => ({ ...prev, [u.id]: "" }));
    setStatus((prev) => ({ ...prev, [u.id]: "sending" }));

    // Split "name" into first/last best-effort
    let firstName: string | undefined;
    let lastName: string | undefined;
    if (u.name) {
      const parts = u.name.split(" ").filter(Boolean);
      if (parts.length === 1) firstName = parts[0]!;
      if (parts.length >= 2) {
        firstName = parts[0]!;
        lastName = parts.slice(1).join(" ");
      }
    }

    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId,
          email: u.email,
          ghlUserId: u.id,
          firstName,
          lastName,
        }),
      });

      const text = await res.text();
      if (!res.ok) {
        let msg = "Failed to send invite";
        let maybeLink = "";
        try {
          const j = JSON.parse(text) as InviteApiErr;
          if (typeof j?.inviteUrl === "string" && j.inviteUrl) maybeLink = j.inviteUrl;
          const errStr =
            typeof j?.error === "string"
              ? j.error
              : isObject(j?.error)
              ? JSON.stringify(j.error)
              : String(j?.error ?? "");
          msg = (j?.step ? `${j.step}: ` : "") + (errStr || msg);
        } catch {
          msg = text || msg;
        }
        if (maybeLink) setLinks((prev) => ({ ...prev, [u.id]: maybeLink }));
        throw new Error(msg);
      }

      const j = JSON.parse(text) as InviteApiOk;
      if (j.inviteUrl) setLinks((prev) => ({ ...prev, [u.id]: j.inviteUrl! }));
      setStatus((prev) => ({ ...prev, [u.id]: "sent" }));
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        [u.id]: (e as Error).message || String(e),
      }));
      setStatus((prev) => ({ ...prev, [u.id]: "error" }));
    }
  }

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // ignore clipboard errors
    }
  }

  return (
    <div className="space-y-3">
      {loading ? <div className="card">Loading users…</div> : null}
      {err ? <div className="card text-red-600">Error: {err}</div> : null}
      {!loading && !err && users.length === 0 ? (
        <div className="card">No users found for this location.</div>
      ) : null}

      {users.map((u) => {
        const st = status[u.id] || "idle";
        const disabled = st === "sending" || !u.email;
        const link = links[u.id];

        return (
          <div key={u.id} className="card flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{u.name || u.email || "(unnamed user)"}</div>
                <div className="text-xs text-gray-500 mt-1">GHL User ID: {u.id}</div>
                {u.email ? (
                  <div className="text-xs text-gray-500">{u.email}</div>
                ) : (
                  <div className="text-xs text-red-600">No email on file — cannot invite.</div>
                )}
                {errors[u.id] ? (
                  <div className="text-xs text-red-600 mt-1">{errors[u.id]}</div>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                {st === "sent" ? (
                  <span className="text-green-700 text-sm">Sent</span>
                ) : st === "sending" ? (
                  <span className="text-sm">Sending…</span>
                ) : st === "error" ? (
                  <span className="text-red-700 text-sm">Failed</span>
                ) : null}

                <button
                  className="btn primary"
                  type="button"
                  onClick={() => handleInvite(u)}
                  disabled={disabled}
                  title={!u.email ? "User has no email" : undefined}
                >
                  {st === "sending" ? "Sending…" : "Invite"}
                </button>
              </div>
            </div>

            {link ? (
              <div className="rounded-lg border p-2 bg-gray-50 text-xs flex items-center gap-2">
                <input
                  readOnly
                  className="flex-1 bg-transparent outline-none"
                  value={link}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Invite link"
                />
                <button type="button" className="btn" onClick={() => copyLink(link)} title="Copy link">
                  Copy
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
