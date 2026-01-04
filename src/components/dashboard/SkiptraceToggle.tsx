"use client";

import { useEffect, useMemo, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebaseClient";

type Props = {
  locationId: string;
};

type ApiResponse = {
  skiptraceEnabled?: boolean;
  skipTracesAvailable?: unknown;
  skipTraceRefresh?: unknown;
  skipTracePurchasedCredits?: unknown;
  error?: string;
};

function buildNextMonthRefreshDate(base: Date): Date {
  const year = base.getFullYear();
  const month = base.getMonth();
  const day = base.getDate();
  const nextMonthIndex = month + 1;
  const targetYear = year + Math.floor(nextMonthIndex / 12);
  const targetMonth = nextMonthIndex % 12;
  const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const safeDay = Math.min(day, daysInTargetMonth);
  return new Date(targetYear, targetMonth, safeDay, 0, 1, 0, 0);
}

function formatLongDate(value: number | null): string | null {
  if (!value) return null;
  return new Date(value).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export default function SkiptraceToggle({ locationId }: Props) {
  const auth = useMemo(() => getFirebaseAuth(), []);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [skipTracesAvailable, setSkipTracesAvailable] = useState<number | null>(null);
  const [skipTraceRefreshAt, setSkipTraceRefreshAt] = useState<number | null>(null);
  const [skipTracePurchasedCredits, setSkipTracePurchasedCredits] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      setSkipTracesAvailable(null);
      setSkipTraceRefreshAt(null);
      setSkipTracePurchasedCredits(null);
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
        const availableRaw = data.skipTracesAvailable;
        const availableParsed =
          typeof availableRaw === "number"
            ? availableRaw
            : typeof availableRaw === "string" && availableRaw.trim()
              ? Number(availableRaw)
              : null;
        const available = Number.isFinite(availableParsed ?? NaN) ? (availableParsed as number) : null;

        const refreshRaw = data.skipTraceRefresh;
        const refreshParsed =
          typeof refreshRaw === "number"
            ? refreshRaw
            : typeof refreshRaw === "string" && refreshRaw.trim()
              ? new Date(refreshRaw).getTime()
              : null;
        const refreshAt = Number.isFinite(refreshParsed ?? NaN) ? (refreshParsed as number) : null;

        const purchasedRaw = data.skipTracePurchasedCredits;
        const purchasedParsed =
          typeof purchasedRaw === "number"
            ? purchasedRaw
            : typeof purchasedRaw === "string" && purchasedRaw.trim()
              ? Number(purchasedRaw)
              : null;
        const purchasedCredits = Number.isFinite(purchasedParsed ?? NaN) ? (purchasedParsed as number) : null;

        if (!cancelled) {
          setEnabled(Boolean(data.skiptraceEnabled));
          setSkipTracesAvailable(available);
          setSkipTraceRefreshAt(refreshAt);
          setSkipTracePurchasedCredits(purchasedCredits);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setSkipTracesAvailable(null);
          setSkipTraceRefreshAt(null);
          setSkipTracePurchasedCredits(null);
        }
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
      const nextRefreshAt = next ? buildNextMonthRefreshDate(new Date()).getTime() : null;
      const res = await fetch("/api/locations/skiptrace", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          locationId,
          skiptraceEnabled: next,
          ...(nextRefreshAt ? { skipTraceRefreshAt: nextRefreshAt } : {}),
        }),
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

  function handleCloseInfo() {
    setShowInfo(false);
  }

  async function handleActivate() {
    if (!acknowledged || saving || loading) return;
    await persistSkiptrace(true, { closeOnSuccess: true, keepOpenOnError: true });
  }

  const isDisabled = loading || saving;
  const knobColor = enabled ? "#16a34a" : "#cbd5e1";
  const trackColor = enabled ? "#dcfce7" : "#e5e7eb";
  const skipTraceBonus = useMemo(
    () => (skipTracePurchasedCredits && skipTracePurchasedCredits > 0 ? skipTracePurchasedCredits : 0),
    [skipTracePurchasedCredits],
  );
  const skipTraceTotal = useMemo(() => 150 + skipTraceBonus, [skipTraceBonus]);
  const skipTraceRemaining = useMemo(() => {
    if (skipTracesAvailable === null) return null;
    return skipTracesAvailable + skipTraceBonus;
  }, [skipTracesAvailable, skipTraceBonus]);
  const skipTraceRefreshLabel = useMemo(() => formatLongDate(skipTraceRefreshAt), [skipTraceRefreshAt]);
  const skipTraceRefreshCopy = skipTraceRefreshLabel
    ? `Monthly credits reset to 150 on ${skipTraceRefreshLabel}. Purchased credits add on top.`
    : "Monthly credits reset to 150 and do not roll over. Purchased credits add on top.";

  return (
    <div style={{ display: "grid", gap: "0.4rem", justifyItems: "end" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", justifyContent: "space-between" }}>
        <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "#0f172a" }}>Skiptrace</span>
        <button
          type="button"
          onClick={() => setShowInfo(true)}
          style={{
            border: "none",
            background: "transparent",
            color: "#2563eb",
            fontSize: "0.8rem",
            fontWeight: 600,
            cursor: "pointer",
            padding: 0,
          }}
        >
          Learn more
        </button>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          flexWrap: "nowrap",
          gap: "0.5rem",
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
            whiteSpace: "nowrap",
          }}
        >
          Off
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
          On
        </span>
      </div>
      {error ? (
        <div style={{ color: "#b91c1c", fontSize: "0.8125rem", marginTop: "0.25rem", textAlign: "right" }}>
          {error}
        </div>
      ) : null}
      {showInfo ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="About skiptrace"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCloseInfo();
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
              width: "min(760px, 96vw)",
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
                  Skiptrace overview
                </div>
                <div style={{ color: "#475569", marginTop: "2px" }}>
                  How skiptrace works and how credits reset.
                </div>
              </div>
              <button
                type="button"
                onClick={handleCloseInfo}
                aria-label="Close skiptrace info"
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "12px",
                  border: "1px solid #e2e8f0",
                  background: "#fff",
                  cursor: "pointer",
                  display: "grid",
                  placeItems: "center",
                  color: "#0f172a",
                  fontWeight: 800,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                }}
              >
                X
              </button>
            </div>
            <div style={{ padding: "18px 18px 20px", overflow: "auto", display: "grid", gap: "16px" }}>
              <div style={{ color: "#0f172a", fontSize: "0.95rem", lineHeight: 1.6 }}>
                Skiptrace looks up contact details for new property submissions so your team can follow up faster.
                Each skiptrace attempt uses 1 credit from your monthly balance.
              </div>
              <div
                style={{
                  display: "grid",
                  gap: "10px",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
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
                  <div style={{ fontWeight: 700, color: "#0f172a" }}>150 credits per month</div>
                  <div style={{ color: "#475569", fontSize: "0.95rem" }}>
                    You receive 150 skiptrace credits every month.
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
                  <div style={{ fontWeight: 700, color: "#0f172a" }}>Resets monthly</div>
                  <div style={{ color: "#475569", fontSize: "0.95rem" }}>
                    Credits reset to 150 and unused credits do not roll over.
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
                  <div style={{ fontWeight: 700, color: "#0f172a" }}>Runs when enabled</div>
                  <div style={{ color: "#475569", fontSize: "0.95rem" }}>
                    Applies to new property submissions while the toggle is on.
                  </div>
                </div>
              </div>
              <div
                style={{
                  border: "1px solid #e2e8f0",
                  borderRadius: "12px",
                  padding: "12px",
                  background: "#f8fafc",
                  display: "grid",
                  gap: "8px",
                }}
              >
                <div style={{ fontWeight: 700, color: "#0f172a" }}>Your credits</div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: "1rem",
                    fontWeight: 700,
                    color: "#0f172a",
                  }}
                >
                  <span>Remaining</span>
                  <span>
                    {skipTraceRemaining ?? "--"} / {skipTraceTotal}
                  </span>
                </div>
                <div style={{ color: "#475569", fontSize: "0.9rem" }}>
                  Remaining updates as skiptraces run. Total includes your monthly credits plus any purchased credits.
                </div>
                <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>{skipTraceRefreshCopy}</div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={handleCloseInfo}
                  style={{
                    padding: "10px 16px",
                    borderRadius: "10px",
                    border: "1px solid #e2e8f0",
                    background: "#fff",
                    color: "#0f172a",
                    fontWeight: 600,
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                  }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
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
                  Enable skiptrace
                </div>
                <div style={{ color: "#475569", marginTop: "2px" }}>
                  Review how credits work before turning it on.
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
                  Skiptrace looks up contact details for new property submissions while this toggle is enabled.
                </p>
                <p style={{ margin: 0, fontSize: "0.95rem", lineHeight: 1.55, color: "#334155" }}>
                  Each skiptrace attempt uses 1 credit. Credits reset monthly and unused credits do not roll over.
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
                  <div style={{ fontWeight: 700, color: "#0f172a" }}>150 credits per month</div>
                  <div style={{ color: "#475569", fontSize: "0.95rem" }}>
                    You receive 150 skiptrace credits each month.
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
                  <div style={{ fontWeight: 700, color: "#0f172a" }}>1 credit per attempt</div>
                  <div style={{ color: "#475569", fontSize: "0.95rem" }}>
                    Each skiptrace uses one credit from your monthly balance.
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
                  <div style={{ fontWeight: 700, color: "#0f172a" }}>Runs on new submissions</div>
                  <div style={{ color: "#475569", fontSize: "0.95rem" }}>
                    Applies to new property submissions while enabled.
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
                  I understand that enabling skiptrace will use monthly skiptrace credits while it is on.
                </span>
              </label>
              {error ? (
                <div style={{ color: "#b91c1c", fontWeight: 600, fontSize: "0.9rem" }}>{error}</div>
              ) : null}
              <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ color: "#475569", fontSize: "0.9rem" }}>
                  You can turn skiptrace off at any time.
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
