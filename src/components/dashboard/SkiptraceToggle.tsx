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
  const [showConfirm, setShowConfirm] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

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

  async function persistSkiptrace(next: boolean, opts?: { closeOnSuccess?: boolean; keepOpenOnError?: boolean }) {
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
      if (opts?.closeOnSuccess) {
        setShowConfirm(false);
        setAcknowledged(false);
      }
    } catch (e) {
      setEnabled(prev);
      setError(e instanceof Error ? e.message : String(e));
      if (opts?.keepOpenOnError) {
        setShowConfirm(true);
      }
    } finally {
      setSaving(false);
    }
  }

  function handleToggle() {
    if (loading || saving) return;
    if (!enabled) {
      setShowConfirm(true);
      setAcknowledged(false);
      setError(null);
      return;
    }
    void persistSkiptrace(false);
  }

  function handleCloseModal() {
    if (saving) return;
    setShowConfirm(false);
    setAcknowledged(false);
  }

  async function handleActivate() {
    if (!acknowledged || saving || loading) return;
    await persistSkiptrace(true, { closeOnSuccess: true, keepOpenOnError: true });
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
          justifyContent: "flex-end",
          flexWrap: "wrap",
          gap: "0.6rem",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: "999px",
          padding: "0.5rem 0.75rem",
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        <span
          style={{
            fontSize: "0.8125rem",
            color: enabled ? "#94a3b8" : "#0f172a",
            fontWeight: 600,
            minWidth: 0,
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
            minWidth: 0,
          }}
        >
          Skiptrace On
        </span>
        <span
          style={{
            fontSize: "0.75rem",
            color: saving ? "#0f172a" : "#475569",
            opacity: loading ? 0.5 : 1,
            flexBasis: "100%",
            textAlign: "right",
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
      {showConfirm ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Skiptrace terms"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCloseModal();
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(15,23,42,0.55)",
            backdropFilter: "blur(4px)",
            display: "grid",
            placeItems: "center",
            padding: "18px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(860px, 96vw)",
              maxHeight: "92vh",
              background: "#fff",
              borderRadius: "18px",
              overflow: "hidden",
              border: "1px solid #e2e8f0",
              boxShadow: "0 28px 80px rgba(15,23,42,0.38)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                padding: "14px 16px",
                borderBottom: "1px solid #e2e8f0",
                background: "linear-gradient(120deg, #f8fafc, #eff6ff)",
              }}
            >
              <div>
                <div style={{ color: "#0f172a", fontWeight: 700, fontSize: "1.05rem" }}>
                  Agree to skiptrace charges
                </div>
                <div style={{ color: "#475569", marginTop: "2px" }}>
                  Enabling skiptrace will bill $0.12 per lookup with safeguards in place.
                </div>
              </div>
              <button
                type="button"
                onClick={handleCloseModal}
                aria-label="Close skiptrace terms"
                disabled={saving}
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "12px",
                  border: "1px solid #e2e8f0",
                  background: "#fff",
                  cursor: saving ? "not-allowed" : "pointer",
                  display: "grid",
                  placeItems: "center",
                  color: "#0f172a",
                  fontWeight: 800,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                  opacity: saving ? 0.6 : 1,
                }}
              >
                X
              </button>
            </div>
            <div style={{ padding: "18px 18px 20px", overflow: "auto", display: "grid", gap: "16px" }}>
              <div style={{ display: "grid", gap: "10px", color: "#0f172a" }}>
                <p style={{ margin: 0, fontSize: "0.975rem", lineHeight: 1.6, color: "#0f172a" }}>
                  Each skiptrace is billed at $0.12. A daily guardrail of 150 skiptraces is enforced to prevent runaway spend.
                </p>
                <p style={{ margin: 0, fontSize: "0.95rem", lineHeight: 1.55, color: "#334155" }}>
                  A custom skiptrace workflow has already been installed for this location. It handles the automation and should not be edited so results continue to flow.
                </p>
              </div>
              <div
                style={{
                  display: "grid",
                  gap: "10px",
                  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                }}
              >
                <div
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "12px",
                    padding: "12px",
                    background: "#f8fafc",
                    display: "grid",
                    gap: "6px",
                  }}
                >
                  <div style={{ fontWeight: 700, color: "#0f172a" }}>$0.12 per skiptrace</div>
                  <div style={{ color: "#475569", fontSize: "0.95rem" }}>
                    Charges apply only while skiptrace is active.
                  </div>
                </div>
                <div
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "12px",
                    padding: "12px",
                    background: "#f0f9ff",
                    display: "grid",
                    gap: "6px",
                  }}
                >
                  <div style={{ fontWeight: 700, color: "#0f172a" }}>150 / day limit</div>
                  <div style={{ color: "#475569", fontSize: "0.95rem" }}>
                    Daily cap keeps spend predictable and prevents spikes.
                  </div>
                </div>
                <div
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "12px",
                    padding: "12px",
                    background: "#fdf2f8",
                    display: "grid",
                    gap: "6px",
                  }}
                >
                  <div style={{ fontWeight: 700, color: "#0f172a" }}>Managed workflow</div>
                  <div style={{ color: "#475569", fontSize: "0.95rem" }}>
                    Skiptrace automation is pre-installed. Avoid edits so it keeps running smoothly.
                  </div>
                </div>
              </div>
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "10px",
                  padding: "12px 14px",
                  borderRadius: "12px",
                  border: "1px solid #e2e8f0",
                  background: "#fff",
                  cursor: saving ? "not-allowed" : "pointer",
                  userSelect: "none",
                }}
              >
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  disabled={saving}
                  style={{ width: "18px", height: "18px", marginTop: "2px", cursor: saving ? "not-allowed" : "pointer" }}
                />
                <span style={{ color: "#0f172a", fontSize: "0.95rem", lineHeight: 1.5 }}>
                  I agree to be charged $0.12 per skiptrace request and understand the daily limit of 150.
                </span>
              </label>
              {error ? (
                <div style={{ color: "#b91c1c", fontWeight: 600, fontSize: "0.9rem" }}>{error}</div>
              ) : null}
              <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ color: "#475569", fontSize: "0.9rem" }}>
                  You can turn skiptrace off at any time. Charges stop immediately.
                </div>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={handleCloseModal}
                    disabled={saving}
                    style={{
                      padding: "10px 14px",
                      borderRadius: "10px",
                      border: "1px solid #e2e8f0",
                      background: "#fff",
                      color: "#0f172a",
                      fontWeight: 600,
                      cursor: saving ? "not-allowed" : "pointer",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                      opacity: saving ? 0.7 : 1,
                    }}
                  >
                    Not now
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleActivate()}
                    disabled={!acknowledged || saving || loading}
                    style={{
                      padding: "10px 16px",
                      borderRadius: "10px",
                      border: "1px solid #2563eb",
                      background: acknowledged && !saving ? "linear-gradient(120deg, #2563eb, #1d4ed8)" : "#e2e8f0",
                      color: acknowledged && !saving ? "#fff" : "#94a3b8",
                      fontWeight: 700,
                      cursor: !acknowledged || saving ? "not-allowed" : "pointer",
                      boxShadow: acknowledged && !saving ? "0 10px 24px rgba(37,99,235,0.25)" : "none",
                      minWidth: "150px",
                    }}
                  >
                    {saving ? "Activating..." : "Activate skiptrace"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
