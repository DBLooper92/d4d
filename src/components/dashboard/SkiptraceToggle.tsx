"use client";

import { useEffect, useMemo, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebaseClient";

type Props = {
  locationId: string;
};

type ApiResponse = { skiptraceEnabled?: boolean; error?: string };

export default function SkiptraceToggle({ locationId }: Props) {
  const auth = useMemo(() => getFirebaseAuth(), []);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const user = auth.currentUser;
        if (!user) throw new Error("Not signed in.");
        const idToken = await user.getIdToken();
        const res = await fetch(`/api/locations/skiptrace?locationId=${encodeURIComponent(locationId)}`, {
          headers: { Authorization: `Bearer ${idToken}` },
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as ApiResponse;
        if (!res.ok || data.error) {
          throw new Error(data.error || `Load failed (${res.status})`);
        }
        if (!cancelled) setEnabled(Boolean(data.skiptraceEnabled));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [auth, locationId]);

  async function handleToggle() {
    if (loading || saving) return;
    const next = !enabled;
    const prev = enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Not signed in.");
      const idToken = await user.getIdToken();
      const res = await fetch("/api/locations/skiptrace", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ locationId, skiptraceEnabled: next }),
      });
      const data = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok || data.error) {
        throw new Error(data.error || `Update failed (${res.status})`);
      }
      setEnabled(Boolean(data.skiptraceEnabled));
    } catch (e) {
      setEnabled(prev);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const isDisabled = loading || saving;
  const knobColor = enabled ? "#16a34a" : "#cbd5e1";
  const trackColor = enabled ? "#dcfce7" : "#e5e7eb";

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: "999px",
          padding: "0.5rem 0.75rem",
        }}
      >
        <span
          style={{
            fontSize: "0.8125rem",
            color: enabled ? "#94a3b8" : "#0f172a",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          Skiptrace Off
        </span>
        <button
          type="button"
          onClick={handleToggle}
          disabled={isDisabled}
          aria-pressed={enabled}
          aria-label={enabled ? "Disable skiptrace" : "Enable skiptrace"}
          style={{
            position: "relative",
            width: "56px",
            height: "32px",
            borderRadius: "999px",
            border: "1px solid #e2e8f0",
            background: trackColor,
            padding: 0,
            cursor: isDisabled ? "not-allowed" : "pointer",
            transition: "background-color 160ms ease, border-color 160ms ease",
            boxShadow: enabled ? "0 0 0 4px rgba(34, 197, 94, 0.1)" : "none",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              top: "4px",
              left: enabled ? "28px" : "4px",
              width: "24px",
              height: "24px",
              borderRadius: "999px",
              background: knobColor,
              boxShadow: "0 2px 6px rgba(0,0,0,0.12)",
              transition: "left 160ms ease, background-color 160ms ease",
              display: "grid",
              placeItems: "center",
            }}
          >
            <span
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "999px",
                background: enabled ? "#15803d" : "#94a3b8",
              }}
            />
          </span>
        </button>
        <span
          style={{
            fontSize: "0.8125rem",
            color: enabled ? "#0f172a" : "#94a3b8",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          Skiptrace On
        </span>
        <span
          style={{
            fontSize: "0.75rem",
            color: saving ? "#0f172a" : "#475569",
            opacity: loading ? 0.5 : 1,
          }}
        >
          {loading ? "Loading..." : saving ? "Saving..." : enabled ? "Active" : "Disabled"}
        </span>
      </div>
      {error ? (
        <div style={{ color: "#b91c1c", fontSize: "0.8125rem", marginTop: "0.25rem" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
