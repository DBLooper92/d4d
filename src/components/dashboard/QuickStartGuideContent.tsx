"use client";

import { useEffect, useMemo, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebaseClient";

type IndustryOption = { id: string; label: string; notes: string[] };
type ApiResponse = {
  industryChosen?: string | null;
  quickNotes?: string[];
  customQuickNotes?: string[];
  error?: string;
};

const INDUSTRY_OPTIONS: IndustryOption[] = [
  {
    id: "real-estate-investors",
    label: "Real Estate Investors",
    notes: [
      "Overgrown lawn / neglected landscaping",
      "Boarded or broken windows",
      "Overflowing or piled mail",
      "Tarp on roof",
      "Vacant or abandoned appearance",
    ],
  },
  {
    id: "roofing-contractors",
    label: "Roofing Contractors",
    notes: [
      "Tarp on roof",
      "Missing or curled shingles",
      "Visible storm damage",
      "Staining on exterior walls",
      "Older roof (15+ years)",
    ],
  },
  {
    id: "solar-installers",
    label: "Solar Installers",
    notes: [
      "South-facing roof",
      "No visible shade obstruction",
      "Large roof surface area",
      "Older home / high utility usage likely",
      "No existing solar panels",
    ],
  },
  {
    id: "landscaping",
    label: "Landscaping & Lawn Care",
    notes: [
      "Overgrown lawn",
      "Weeds in driveway or walkways",
      "Poor curb appeal",
      "Untrimmed hedges or trees",
      "Dead or patchy grass",
    ],
  },
  {
    id: "painting-contractors",
    label: "Painting Contractors",
    notes: [
      "Chipping or peeling paint",
      "Faded exterior color",
      "Water stains on siding",
      "Bare wood exposed",
      "Prior paint job failing",
    ],
  },
  {
    id: "pest-control",
    label: "Pest Control Companies",
    notes: [
      "Visible insect activity",
      "Overgrown vegetation near structure",
      "Standing water nearby",
      "Wood rot or damaged siding",
      "Trash or debris buildup",
    ],
  },
  {
    id: "pressure-washing",
    label: "Pressure Washing & Exterior Cleaning",
    notes: [
      "Dirty siding or brick",
      "Mold or mildew stains",
      "Oil stains on driveway",
      "Roof discoloration",
      "Walkways darkened or slick",
    ],
  },
  {
    id: "window-door-replacement",
    label: "Window & Door Replacement",
    notes: [
      "Cracked or foggy windows",
      "Outdated window style",
      "Visible frame rot",
      "Drafty or poorly sealed doors",
      "Mismatched windows",
    ],
  },
  {
    id: "home-remodeling",
    label: "Home Remodeling & General Contractors",
    notes: [
      "Add-on or unpermitted structure visible",
      "Aging exterior materials",
      "Foundation or structural cracks",
      "Outdated design / curb appeal",
      "Signs of ongoing DIY work",
    ],
  },
  {
    id: "commercial-cleaning",
    label: "Commercial Cleaning & Janitorial Services",
    notes: [
      "Dirty storefront windows",
      "Overflowing trash bins",
      "Stained sidewalks or entrances",
      "Poor exterior upkeep",
      "High foot traffic location",
    ],
  },
  { id: "other", label: "Other", notes: [] },
];

function normalizeIndustryId(value: string | null | undefined): string {
  if (!value || !value.trim()) return "";
  const trimmed = value.trim().toLowerCase();
  const match = INDUSTRY_OPTIONS.find(
    (opt) => opt.id.toLowerCase() === trimmed || opt.label.toLowerCase() === trimmed,
  );
  return match?.id ?? trimmed;
}

function clampCustomNotes(list: string[]): string[] {
  return list
    .map((n) => n.slice(0, 25).trim())
    .filter(Boolean)
    .slice(0, 5);
}

function formatNotesForDisplay(list: string[]): string[] {
  return list.map((n) => n.trim()).filter(Boolean).slice(0, 5);
}

export default function QuickStartGuideContent({ locationId }: { locationId: string }) {
  const auth = useMemo(() => getFirebaseAuth(), []);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [step, setStep] = useState<"industry" | "guide">("industry");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customNotes, setCustomNotes] = useState<string[]>(["", "", "", "", ""]);
  const [persistedIndustry, setPersistedIndustry] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notesVisible, setNotesVisible] = useState<boolean>(false);

  const selectedOption = useMemo(
    () => INDUSTRY_OPTIONS.find((opt) => opt.id === selectedId) ?? null,
    [selectedId],
  );

  const quickNotes = useMemo(() => {
    if (selectedOption?.id === "other") {
      return clampCustomNotes(customNotes);
    }
    return selectedOption?.notes ?? [];
  }, [selectedOption, customNotes]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const user = auth.currentUser;
        if (!user) throw new Error("Not signed in.");
        const idToken = await user.getIdToken();
        const res = await fetch(
          `/api/locations/industry?locationId=${encodeURIComponent(locationId)}`,
          {
            cache: "no-store",
            headers: { Authorization: `Bearer ${idToken}` },
          },
        );
        const data = (await res.json().catch(() => ({}))) as ApiResponse;
        if (!res.ok || data.error) {
          throw new Error(data.error || `Failed to load (${res.status})`);
        }
        const normalized = normalizeIndustryId(data.industryChosen);
        const serverCustomNotes = formatNotesForDisplay(data.customQuickNotes ?? []);

        const paddedCustom = [...serverCustomNotes];
        while (paddedCustom.length < 5) paddedCustom.push("");
        setCustomNotes(paddedCustom.slice(0, 5));

        if (normalized) {
          const opt = INDUSTRY_OPTIONS.find((o) => o.id === normalized);
          setSelectedId(opt?.id ?? normalized);
          setPersistedIndustry(data.industryChosen || opt?.label || normalized);
          // If current choice is "other" use custom notes; otherwise use saved quick notes.
          if (normalized === "other") {
            if (!serverCustomNotes.length) {
              setCustomNotes((prev) => {
                const next = [...prev];
                if (next.every((n) => !n.trim())) {
                  next[0] = "";
                }
                return next.slice(0, 5);
              });
            }
          }
          setStep("guide");
        } else {
          setSelectedId(null);
          setStep("industry");
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
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

  useEffect(() => {
    setNotesVisible(false);
    const t = setTimeout(() => setNotesVisible(true), 10);
    return () => clearTimeout(t);
  }, [selectedId]);

  const selectedLabel = selectedOption?.label ?? persistedIndustry ?? null;

  async function handleConfirm() {
    if (!selectedOption) {
      setError("Choose an industry to continue.");
      return;
    }
    if (selectedOption.id === "other" && quickNotes.length === 0) {
      setError("Add at least one quick note for your custom industry.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Not signed in.");
      const idToken = await user.getIdToken();
      const payload = {
        locationId,
        industryChosen: selectedOption.label,
        quickNotes,
        idToken,
      };
      const res = await fetch("/api/locations/industry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as ApiResponse;
      if (!res.ok || data.error) {
        throw new Error(data.error || `Failed to save (${res.status})`);
      }
      setPersistedIndustry(data.industryChosen || selectedOption.label);
      if (selectedOption.id === "other") {
        const savedCustom = formatNotesForDisplay(
          data.customQuickNotes ?? data.quickNotes ?? quickNotes,
        );
        const padded = [...savedCustom];
        while (padded.length < 5) padded.push("");
        setCustomNotes(padded.slice(0, 5));
      }
      setStep("guide");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function updateCustomNote(idx: number, value: string) {
    setCustomNotes((prev) => {
      const next = [...prev];
      next[idx] = value.slice(0, 25);
      return next;
    });
  }

  if (loading) {
    return (
      <div style={{ padding: "6px 0", display: "grid", gap: "12px" }}>
        <div className="skel" style={{ height: "20px", width: "40%" }} />
        <div className="skel" style={{ height: "14px", width: "60%" }} />
        <div className="skel" style={{ height: "160px", width: "100%" }} />
      </div>
    );
  }

  if (step === "guide") {
    return (
      <div style={{ padding: "6px 0", display: "grid", gap: "12px" }}>
        <h2 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 800, color: "#0f172a" }}>
          Quick Start Guide
        </h2>
        <div style={{ color: "#475569" }}>
          {selectedLabel ? `You're set up for ${selectedLabel}.` : "You're set up and ready to go."}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "16px" }}>
      <div>
        <h2 style={{ margin: 0, fontSize: "1.22rem", fontWeight: 800, color: "#0f172a" }}>
          Choose your industry
        </h2>
        <div style={{ color: "#475569", marginTop: "4px" }}>
          Pick one so we can preload relevant quick notes for your team&apos;s mobile submissions.
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gap: "14px",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          alignItems: "start",
        }}
      >
        <div style={{ display: "grid", gap: "8px" }}>
          {INDUSTRY_OPTIONS.map((opt, idx) => {
            const active = selectedId === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  setSelectedId(opt.id);
                  setError(null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                  padding: "12px 14px",
                  borderRadius: "12px",
                  border: active ? "2px solid #2563eb" : "1px solid #e2e8f0",
                  background: active ? "#eff6ff" : "#fff",
                  color: "#0f172a",
                  cursor: "pointer",
                  boxShadow: active ? "0 10px 24px rgba(37,99,235,0.18)" : "0 1px 2px rgba(0,0,0,0.04)",
                  textAlign: "left",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: "20px",
                      height: "20px",
                      borderRadius: "999px",
                      border: active ? "6px solid #2563eb" : "2px solid #cbd5e1",
                      background: "#fff",
                      boxShadow: active ? "0 0 0 4px rgba(37,99,235,0.16)" : "none",
                    }}
                  />
                  <div style={{ display: "grid", gap: "2px" }}>
                    <div style={{ fontWeight: 700 }}>{opt.label}</div>
                    <div style={{ color: "#94a3b8", fontSize: "0.9rem" }}>
                      Option {idx + 1}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
          <div style={{ color: "#94a3b8", fontSize: "0.92rem", marginTop: "4px" }}>
            This can be changed later in settings.
          </div>
        </div>

        <div
          className="card"
          style={{
            margin: 0,
            borderColor: "#e2e8f0",
            minHeight: "200px",
            display: "grid",
            gap: "12px",
            background: "#f8fafc",
            overflow: "hidden",
          }}
        >
          <div style={{ color: "#0f172a", fontWeight: 700 }}>
            Quick notes preview
          </div>
          <div style={{ color: "#475569", fontSize: "0.95rem", lineHeight: 1.5 }}>
            These quick notes will auto-fill the notes section when drivers submit properties in the mobile app.
          </div>
          {selectedOption ? (
            <div
              key={selectedOption.id}
              style={{
                transform: notesVisible ? "translateX(0)" : "translateX(14px)",
                opacity: notesVisible ? 1 : 0,
                transition: "transform 180ms ease, opacity 180ms ease",
                display: "grid",
                gap: "10px",
              }}
            >
              {selectedOption.id === "other" ? (
                <div style={{ display: "grid", gap: "8px" }}>
                  <div style={{ color: "#0f172a", fontWeight: 700 }}>Create your quick notes</div>
                  <div style={{ color: "#475569", fontSize: "0.95rem" }}>
                    Provide up to 5 short notes (25 characters each). Minimum 1 required.
                  </div>
                  <div style={{ display: "grid", gap: "8px" }}>
                    {customNotes.map((val, idx) => (
                      <input
                        key={idx}
                        type="text"
                        value={val}
                        maxLength={25}
                        onChange={(e) => updateCustomNote(idx, e.target.value)}
                        placeholder={`Quick note ${idx + 1}`}
                        style={{
                          width: "100%",
                          padding: "10px 12px",
                          borderRadius: "10px",
                          border: "1px solid #e2e8f0",
                          background: "#fff",
                          color: "#0f172a",
                          fontSize: "0.95rem",
                        }}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ display: "grid", gap: "8px" }}>
                  <div style={{ color: "#0f172a", fontWeight: 700 }}>
                    {selectedOption.label} quick notes
                  </div>
                  <ul style={{ margin: 0, paddingInlineStart: "18px", display: "grid", gap: "6px", color: "#0f172a" }}>
                    {quickNotes.map((note, idx) => (
                      <li key={`${note}-${idx}`} style={{ lineHeight: 1.5 }}>
                        {note}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: "#94a3b8", fontSize: "0.95rem" }}>
              Pick an industry to see the quick notes that will be used.
            </div>
          )}
        </div>
      </div>

      {error ? (
        <div
          className="card"
          style={{
            margin: 0,
            borderColor: "#fecaca",
            background: "#fff1f2",
            color: "#b91c1c",
          }}
        >
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", alignItems: "center" }}>
        <div style={{ color: "#94a3b8", fontSize: "0.95rem" }}>This can be changed later in settings.</div>
        <button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={!selectedOption || saving || (selectedOption.id === "other" && quickNotes.length === 0)}
          style={{
            padding: "10px 16px",
            borderRadius: "12px",
            border: "1px solid #2563eb",
            background:
              !selectedOption || (selectedOption.id === "other" && quickNotes.length === 0)
                ? "#e2e8f0"
                : "linear-gradient(120deg, #2563eb, #1d4ed8)",
            color:
              !selectedOption || (selectedOption.id === "other" && quickNotes.length === 0)
                ? "#94a3b8"
                : "#fff",
            fontWeight: 800,
            cursor:
              !selectedOption || (selectedOption.id === "other" && quickNotes.length === 0) || saving
                ? "not-allowed"
                : "pointer",
            boxShadow:
              !selectedOption || (selectedOption.id === "other" && quickNotes.length === 0)
                ? "none"
                : "0 12px 30px rgba(37,99,235,0.24)",
            minWidth: "120px",
            opacity: saving ? 0.8 : 1,
          }}
        >
          {saving ? "Saving..." : "Confirm"}
        </button>
      </div>
    </div>
  );
}
