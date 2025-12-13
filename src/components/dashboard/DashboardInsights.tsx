"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  type DocumentData,
  type FirestoreError,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { getFirebaseFirestore, getFirebaseAuth } from "@/lib/firebaseClient";
import { getDocs } from "firebase/firestore";

type SubmissionDoc = {
  id: string;
  createdAt: number | null;
  coordinates: { lat: number; lng: number } | null;
  createdByUserId: string | null;
  addressLabel: string | null;
  status: string | null;
  contactId: string | null;
};

type MarkerDoc = {
  id: string;
  lat: number;
  lng: number;
  createdByUserId?: string | null;
};

type Props = {
  locationId: string;
};

const palette = [
  "#2563eb",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#0ea5e9",
  "#f97316",
  "#22c55e",
  "#14b8a6",
  "#e11d48",
];

function hashToIndex(str: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h % mod;
}

type GhlUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};
type ManageUser = GhlUser & { firebaseUid?: string | null };

function extractDisplayName(data: Record<string, unknown>): string | null {
  const first = typeof data.firstName === "string" ? data.firstName.trim() : "";
  const last = typeof data.lastName === "string" ? data.lastName.trim() : "";
  const composed = [first, last].filter(Boolean).join(" ").trim();
  if (composed) return composed;

  const nameFields: Array<keyof typeof data> = ["name", "displayName", "fullName"];
  for (const key of nameFields) {
    const raw = data[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }

  const email = typeof data.email === "string" ? data.email.trim() : "";
  return email || null;
}

function extractGhlUserId(data: Record<string, unknown>): string {
  if (typeof (data as { ghlUserId?: unknown }).ghlUserId === "string") {
    return ((data as { ghlUserId?: string }).ghlUserId as string).trim();
  }
  const nested = (data as { ghl?: { userId?: unknown } }).ghl;
  if (nested && typeof nested.userId === "string") {
    return nested.userId.trim();
  }
  return "";
}

function cleanFirebaseUid(data: Record<string, unknown>): string {
  const uid = (data as { firebaseUid?: unknown }).firebaseUid;
  return typeof uid === "string" ? uid.trim() : "";
}

function colorForUser(id: string | null | undefined): string {
  const key = (id || "Unassigned").trim() || "Unassigned";
  return palette[hashToIndex(key, palette.length)];
}

function storeDisplay(target: Record<string, string>, id: string | null | undefined, display: string | null | undefined) {
  const key = (id || "").trim();
  const value = (display || "").trim();
  if (!key || !value) return;
  if (!target[key]) target[key] = value;
  const short = key.length > 6 ? key.slice(0, 6) : "";
  if (short && !target[short]) target[short] = value;
}

function toMillis(value: unknown): number | null {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const asDate = (value as { toMillis?: () => number }).toMillis?.();
  return typeof asDate === "number" && Number.isFinite(asDate) ? asDate : null;
}

function parseSubmission(docSnap: QueryDocumentSnapshot<DocumentData>): SubmissionDoc | null {
  const data = docSnap.data() as Record<string, unknown>;
  const coords =
    data && typeof data === "object" && "coordinates" in data
      ? (data.coordinates as { lat?: unknown; lng?: unknown })
      : null;
  const lat = coords && typeof coords.lat === "number" ? coords.lat : null;
  const lng = coords && typeof coords.lng === "number" ? coords.lng : null;
  const nestedContactId =
    typeof (data as { ghl?: { contactId?: unknown } })?.ghl?.contactId === "string"
      ? ((data as { ghl?: { contactId?: string } }).ghl?.contactId ?? null)
      : null;
  const contactId =
    typeof (data as { contactId?: unknown })?.contactId === "string"
      ? ((data as { contactId?: string }).contactId ?? null)
      : nestedContactId;

  return {
    id: docSnap.id,
    createdAt: toMillis((data as { createdAt?: unknown })?.createdAt),
    coordinates: lat !== null && lng !== null ? { lat, lng } : null,
    createdByUserId:
      typeof (data as { createdByUserId?: unknown })?.createdByUserId === "string"
        ? ((data as { createdByUserId?: string }).createdByUserId ?? null)
        : null,
    addressLabel:
      typeof (data as { address?: { label?: unknown } })?.address?.label === "string"
        ? ((data as { address?: { label?: string } }).address?.label ?? null)
        : null,
    status: typeof (data as { status?: unknown })?.status === "string"
      ? ((data as { status?: string }).status ?? null)
      : null,
    contactId: contactId ?? null,
  };
}

function parseMarker(docSnap: QueryDocumentSnapshot<DocumentData>): MarkerDoc | null {
  const data = docSnap.data() as Record<string, unknown>;
  const lat = typeof data.lat === "number" ? data.lat : null;
  const lng = typeof data.lng === "number" ? data.lng : null;
  if (lat === null || lng === null) return null;
  const createdByUserId =
    typeof (data as { createdByUserId?: unknown }).createdByUserId === "string"
      ? ((data as { createdByUserId?: string }).createdByUserId as string)
      : null;
  return { id: docSnap.id, lat, lng, createdByUserId };
}

function useLocationStreams(locationId: string) {
  const [submissions, setSubmissions] = useState<SubmissionDoc[]>([]);
  const [markers, setMarkers] = useState<MarkerDoc[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    if (!locationId) {
      setSubmissions([]);
      setMarkers([]);
      setLoading(false);
      return;
    }
    const db = getFirebaseFirestore();

    const submissionsRef = collection(db, "locations", locationId, "submissions");
    const markersRef = collection(db, "locations", locationId, "markers");

    const unsubmissions = onSnapshot(
      query(submissionsRef, orderBy("createdAt", "desc")),
      (snapshot) => {
        const list = snapshot.docs
          .map((doc) => parseSubmission(doc))
          .filter((s): s is SubmissionDoc => s !== null);
        setSubmissions(list);
        setLoading(false);
      },
      (error: FirestoreError) => {
        console.error("Failed to load submissions:", error);
        setSubmissions([]);
        setLoading(false);
      }
    );

    const unmarkers = onSnapshot(
      markersRef,
      (snapshot) => {
        const list = snapshot.docs
          .map((doc) => parseMarker(doc))
          .filter((m): m is MarkerDoc => m !== null);
        setMarkers(list);
      },
      (error: FirestoreError) => {
        console.error("Failed to load markers:", error);
        setMarkers([]);
      }
    );

    return () => {
      unsubmissions();
      unmarkers();
    };
  }, [locationId]);

  return { submissions, markers, loading };
}

type DonutDatum = { label: string; value: number; color: string };

function DonutChart({ data }: { data: DonutDatum[] }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (!total) {
    return (
      <div
        style={{
          display: "grid",
          placeItems: "center",
          height: "220px",
          background: "#f8fafc",
          borderRadius: "12px",
          border: "1px dashed #e2e8f0",
          color: "#94a3b8",
          fontSize: "0.95rem",
        }}
      >
        No submissions yet
      </div>
    );
  }

  let cumulative = 0;
  const radius = 80;
  const center = 100;
  const stroke = 26;

  const toPoint = (angle: number) => {
    const rad = (angle * Math.PI) / 180;
    return {
      x: center + radius * Math.cos(rad),
      y: center + radius * Math.sin(rad),
    };
  };

  const arcs = data.map((d) => {
    const startAngle = (cumulative / total) * 360;
    cumulative += d.value;
    const endAngle = (cumulative / total) * 360;
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;
    const start = toPoint(startAngle - 90);
    const end = toPoint(endAngle - 90);
    const path = `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
    const midAngle = startAngle + (endAngle - startAngle) / 2;
    const label = `${Math.round((d.value / total) * 100)}%`;
    const labelPos = toPoint(midAngle - 90);
    return { path, color: d.color, label, labelPos, value: d.value, name: d.label };
  });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: "16px", alignItems: "center" }}>
      <div style={{ position: "relative", width: 200, height: 200 }}>
        <svg viewBox="0 0 200 200" role="img" aria-label="Submissions by person">
          {arcs.map((arc, idx) => (
            <g key={arc.name}>
              <path
                d={arc.path}
                fill="none"
                stroke={arc.color}
                strokeWidth={stroke}
                strokeLinecap="butt"
              />
              {arc.value > 0 && (
                <text
                  x={arc.labelPos.x}
                  y={arc.labelPos.y}
                  dy={4}
                  textAnchor="middle"
                  fontSize="10"
                  fill="#0f172a"
                >
                  {arc.label}
                </text>
              )}
            </g>
          ))}
          <circle cx={center} cy={center} r={radius - stroke + 6} fill="#fff" />
          <text
            x={center}
            y={center - 4}
            textAnchor="middle"
            fontSize="18"
            fontWeight={600}
            fill="#0f172a"
          >
            {total}
          </text>
          <text
            x={center}
            y={center + 16}
            textAnchor="middle"
            fontSize="12"
            fill="#475569"
          >
            submissions
          </text>
        </svg>
      </div>
      <div style={{ display: "grid", gap: "8px" }}>
        {data.map((d) => (
          <div key={d.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                style={{
                  width: "14px",
                  height: "14px",
                  borderRadius: "4px",
                  background: d.color,
                  border: "1px solid rgba(15,23,42,0.08)",
                }}
              />
              <span style={{ color: "#0f172a", fontWeight: 600 }}>{d.label}</span>
            </div>
            <span style={{ color: "#475569" }}>
              {d.value} • {Math.round((d.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniBars({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "10px", height: "140px" }}>
      {data.map((d) => (
        <div key={d.label} style={{ flex: 1, textAlign: "center" }}>
          <div
            style={{
              height: `${(d.value / max) * 120}px`,
              background: "linear-gradient(180deg, #3b82f6, #2563eb)",
              borderRadius: "10px 10px 6px 6px",
              boxShadow: "0 6px 12px rgba(37, 99, 235, 0.18)",
            }}
            title={`${d.label}: ${d.value}`}
          />
          <div style={{ marginTop: "6px", fontSize: "11px", color: "#475569" }}>{d.label}</div>
        </div>
      ))}
    </div>
  );
}

function StatusBadges({ counts }: { counts: Record<string, number> }) {
  const palette = {
    submitted: "#16a34a",
    pending: "#2563eb",
    failed: "#e11d48",
  } as const;

  const entries = Object.entries(counts).filter(([, v]) => v > 0);
  if (!entries.length) {
    return <div style={{ color: "#94a3b8", fontSize: "0.95rem" }}>No submissions yet</div>;
  }
  return (
    <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
      {entries.map(([status, value]) => {
        const color = (palette as Record<string, string>)[status] ?? "#0f172a";
        return (
          <div
            key={status}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "6px 10px",
              borderRadius: "999px",
              border: "1px solid #e2e8f0",
              background: "#fff",
              boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
            }}
          >
            <span
              style={{
                width: "10px",
                height: "10px",
                borderRadius: "999px",
                background: color,
              }}
            />
            <span style={{ fontWeight: 600, color: "#0f172a" }}>{status}</span>
            <span style={{ color: "#475569", fontSize: "0.9rem" }}>{value}</span>
          </div>
        );
      })}
    </div>
  );
}

function DashboardMap({ markers, markerOwners }: { markers: MarkerDoc[]; markerOwners: Map<string, string> }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRefs = useRef<maplibregl.Marker[]>([]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
      center: [-98.5795, 39.8283],
      zoom: 3.5,
      attributionControl: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showCompass: false }), "top-right");
    return () => {
      markerRefs.current.forEach((m) => m.remove());
      markerRefs.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markerRefs.current.forEach((m) => m.remove());
    markerRefs.current = [];
    if (!markers.length) {
      map.easeTo({ center: [-98.5795, 39.8283], zoom: 3.5, duration: 400 });
      return;
    }

    const bounds = new maplibregl.LngLatBounds();
    markers.forEach((m) => {
      bounds.extend([m.lng, m.lat]);
      const coordKey = `${m.lat.toFixed(5)},${m.lng.toFixed(5)}`;
      const ownerId = (m.createdByUserId || "").trim() || markerOwners.get(coordKey) || "Unassigned";
      const marker = new maplibregl.Marker({ color: colorForUser(ownerId) })
        .setLngLat([m.lng, m.lat])
        .addTo(map);
      markerRefs.current.push(marker);
    });

    if (markers.length === 1) {
      map.easeTo({ center: [markers[0].lng, markers[0].lat], zoom: 13, duration: 500 });
    } else {
      map.fitBounds(bounds, { padding: 40, maxZoom: 12, duration: 600 });
    }
  }, [markers]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "320px",
        borderRadius: "12px",
        overflow: "hidden",
        border: "1px solid #e2e8f0",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}
    />
  );
}

export default function DashboardInsights({ locationId }: Props) {
  const { submissions, markers, loading } = useLocationStreams(locationId);
  const [userNames, setUserNames] = useState<Record<string, string>>({});

  const resolveUserName = useMemo(
    () =>
      (id: string | null | undefined, fallbackPrefix = "User") => {
        if (!id) return "Unassigned";
        const trimmed = id.trim();
        if (!trimmed) return "Unassigned";
        const short = trimmed.length > 6 ? trimmed.slice(0, 6) : trimmed;
        if (userNames[trimmed]) return userNames[trimmed];
        if (userNames[short]) return userNames[short];

        // As a last resort, try to match by prefix against any stored ids (helps if we only stored full IDs)
        const prefixHit = Object.entries(userNames).find(([key]) => key.startsWith(short));
        if (prefixHit) return prefixHit[1];

        return `${fallbackPrefix} ${short}`;
      },
    [userNames],
  );

  useEffect(() => {
    let cancelled = false;
    async function loadUsers() {
      if (!locationId) {
        setUserNames({});
        return;
      }
      try {
        const map: Record<string, string> = {};

        // 1) Authenticated manage endpoint (includes firebaseUid)
        try {
          const auth = getFirebaseAuth();
          const token = await auth.currentUser?.getIdToken();
          const qs = new URLSearchParams({ location_id: locationId });
          if (token) qs.set("idToken", token);
          const res = await fetch(`/api/location-users/manage?${qs.toString()}`, {
            cache: "no-store",
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          });
          const json = (await res.json().catch(() => ({}))) as
            | { users?: ManageUser[] }
            | { data?: { users?: ManageUser[] } };
          const users = (json as { users?: ManageUser[] }).users ??
            (json as { data?: { users?: ManageUser[] } }).data?.users ??
            [];
          users.forEach((u) => {
            const display = extractDisplayName(u as Record<string, unknown>);
            if (!display) return;
            storeDisplay(map, u.firebaseUid, display);
            storeDisplay(map, u.id, display);
          });
        } catch {
          /* non-fatal */
        }

        // 2) Public location-users endpoint as fallback (id/name/email)
        try {
          const res = await fetch(
            `/api/ghl/location-users?location_id=${encodeURIComponent(locationId)}`,
            { cache: "no-store" }
          );
          const json = (await res.json().catch(() => ({}))) as
            | { users?: GhlUser[] }
            | { data?: { users?: GhlUser[] } };
          const users = (json as { users?: GhlUser[] }).users ??
            (json as { data?: { users?: GhlUser[] } }).data?.users ??
            [];
          users.forEach((u) => {
            const display = extractDisplayName(u as Record<string, unknown>);
            if (!display || !u.id) return;
            storeDisplay(map, u.id, display);
          });
        } catch {
          /* ignore */
        }

        // 3) Location user directory map (populated by manage endpoint)
        try {
          const db = getFirebaseFirestore();
          const locSnap = await getDoc(doc(db, "locations", locationId));
          if (locSnap.exists()) {
            const data = (locSnap.data() || {}) as Record<string, unknown>;
            const dir = (data as { userDirectory?: Record<string, unknown> }).userDirectory;
            if (dir && typeof dir === "object") {
              Object.entries(dir).forEach(([ghlUserId, raw]) => {
                if (!raw || typeof raw !== "object") return;
                const entry = raw as Record<string, unknown>;
                const display = extractDisplayName(entry);
                storeDisplay(map, ghlUserId, display || null);
                const firebaseUid = cleanFirebaseUid(entry);
                storeDisplay(map, firebaseUid, display || null);
              });
            }
          }
        } catch {
          /* non-fatal */
        }

        // 4) Firestore location users (captures accepted drivers with names)
        try {
          const db = getFirebaseFirestore();
          const snap = await getDocs(collection(db, "locations", locationId, "users"));
          snap.forEach((docSnap) => {
            const data = (docSnap.data() || {}) as Record<string, unknown>;
            const uid = docSnap.id;
            const display = extractDisplayName(data);
            if (display) {
              storeDisplay(map, uid, display);
              const ghlId = extractGhlUserId(data);
              storeDisplay(map, ghlId, display);
            }
          });
        } catch {
          /* ignore */
        }

        if (!cancelled) setUserNames(map);
      } catch {
        if (!cancelled) setUserNames({});
      }
    }
    void loadUsers();
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  useEffect(() => {
    if (!locationId) return;

    const uniqueIds = Array.from(
      new Set(
        submissions
          .map((s) => (s.createdByUserId || "").trim())
          .filter((id): id is string => Boolean(id)),
      )
    );
    const missing = uniqueIds.filter((id) => !userNames[id]);
    if (missing.length === 0) return;

    let cancelled = false;
    async function hydrateMissingUsers() {
      const db = getFirebaseFirestore();
      const updates: Record<string, string> = {};

      await Promise.all(
        missing.map(async (id) => {
          try {
            const locSnap = await getDoc(doc(db, "locations", locationId, "users", id));
            let source = locSnap.exists()
              ? ((locSnap.data() || {}) as Record<string, unknown>)
              : null;
            let display = source ? extractDisplayName(source) : null;
            let ghlId = source ? extractGhlUserId(source) : "";

            if (!display) {
              const rootSnap = await getDoc(doc(db, "users", id));
              if (rootSnap.exists()) {
                source = (rootSnap.data() || {}) as Record<string, unknown>;
                display = extractDisplayName(source);
                if (!ghlId) ghlId = extractGhlUserId(source);
              }
            }

            if (display) {
              storeDisplay(updates, id, display);
              storeDisplay(updates, ghlId, display);
            }
          } catch {
            /* ignore missing users */
          }
        }),
      );

      if (!cancelled && Object.keys(updates).length) {
        setUserNames((prev) => ({ ...prev, ...updates }));
      }
    }

    void hydrateMissingUsers();
    return () => {
      cancelled = true;
    };
  }, [locationId, submissions, userNames]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { submitted: 0, pending: 0, failed: 0 };
    submissions.forEach((s) => {
      const status = (s.status || "pending").toLowerCase();
      if (status.includes("fail") || status.includes("error")) counts.failed += 1;
      else if (status.includes("submit")) counts.submitted += 1;
      else counts.pending += 1;
    });
    return counts;
  }, [submissions]);

  const donutData = useMemo<DonutDatum[]>(() => {
    const grouped = new Map<string, number>();
    submissions.forEach((s) => {
      const key = s.createdByUserId || "Unassigned";
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    });
    const entries = Array.from(grouped.entries()).sort((a, b) => b[1] - a[1]);
    return entries.map(([label, value]) => ({
      label: resolveUserName(label),
      value,
      color: colorForUser(label),
    }));
  }, [submissions, resolveUserName]);

  const last7Days = useMemo(() => {
    const today = new Date();
    const days: { label: string; value: number }[] = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString(undefined, { weekday: "short" });
      const value = submissions.filter((s) => {
        if (!s.createdAt) return false;
        const dayKey = new Date(s.createdAt).toISOString().slice(0, 10);
        return dayKey === key;
      }).length;
      days.push({ label, value });
    }
    return days;
  }, [submissions]);

  const recent = useMemo(() => submissions.slice(0, 6), [submissions]);

  const markerOwnerMap = useMemo(() => {
    const map = new Map<string, string>();
    submissions.forEach((s) => {
      if (!s.coordinates) return;
      const owner = (s.createdByUserId || "").trim();
      if (!owner) return;
      const key = `${s.coordinates.lat.toFixed(5)},${s.coordinates.lng.toFixed(5)}`;
      if (!map.has(key)) map.set(key, owner);
    });
    return map;
  }, [submissions]);

  const userColorGuide = useMemo(() => {
    const submissionCounts = new Map<string, number>();
    submissions.forEach((s) => {
      const id = (s.createdByUserId || "Unassigned").trim() || "Unassigned";
      submissionCounts.set(id, (submissionCounts.get(id) ?? 0) + 1);
    });

    const entries = new Map<string, { id: string; name: string; color: string; count: number }>();
    const addEntry = (id: string, count: number) => {
      const name = resolveUserName(id);
      const key = name.toLowerCase();
      const existing = entries.get(key);
      if (!existing || count > existing.count) {
        entries.set(key, { id, name, color: colorForUser(id), count });
      }
    };

    submissionCounts.forEach((count, id) => addEntry(id, count));

    Object.keys(userNames)
      .filter((id) => id.length > 10) // skip short aliases
      .forEach((id) => {
        const count = submissionCounts.get(id) ?? 0;
        addEntry(id, count);
      });

    return Array.from(entries.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
  }, [submissions, userNames, resolveUserName]);

  return (
    <section className="card" style={{ marginTop: "1.5rem", display: "grid", gap: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: "0.9rem", color: "#475569" }}>Location data</div>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, color: "#0f172a" }}>
            Submissions & coverage
          </h2>
          <div style={{ marginTop: "4px", color: "#64748b" }}>
            Live from Firestore · {submissions.length} submissions · {markers.length} markers
          </div>
        </div>
        {loading && <div className="skel" style={{ width: "120px", height: "14px" }} />}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "12px",
        }}
      >
        <div className="card" style={{ margin: 0, borderColor: "#e2e8f0" }}>
          <div style={{ color: "#475569", fontSize: "0.9rem" }}>Total submissions</div>
          <div style={{ fontSize: "2rem", fontWeight: 700, color: "#0f172a" }}>{submissions.length}</div>
        </div>
        <div className="card" style={{ margin: 0, borderColor: "#e2e8f0" }}>
          <div style={{ color: "#475569", fontSize: "0.9rem" }}>Active markers</div>
          <div style={{ fontSize: "2rem", fontWeight: 700, color: "#0f172a" }}>{markers.length}</div>
        </div>
        <div className="card" style={{ margin: 0, borderColor: "#e2e8f0" }}>
          <div style={{ color: "#475569", fontSize: "0.9rem" }}>Status mix</div>
          <StatusBadges counts={statusCounts} />
        </div>
      </div>

      <div className="card" style={{ margin: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>Users & colors</h3>
        </div>
        {userColorGuide.length ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
            {userColorGuide.map((u) => (
              <div
                key={u.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "8px 10px",
                  border: "1px solid #e2e8f0",
                  borderRadius: "10px",
                  background: "#fff",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: "16px",
                    height: "16px",
                    borderRadius: "6px",
                    background: u.color,
                    border: "1px solid rgba(15,23,42,0.12)",
                    boxShadow: "0 2px 4px rgba(0,0,0,0.08)",
                  }}
                />
                <div style={{ display: "grid", gap: "2px" }}>
                  <div style={{ fontWeight: 600, color: "#0f172a" }}>{u.name}</div>
                  <div style={{ fontSize: "0.85rem", color: "#475569" }}>
                    {u.count} submission{u.count === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: "#94a3b8", fontSize: "0.95rem" }}>No users yet.</div>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 1fr) minmax(320px, 1fr)",
          gap: "14px",
          alignItems: "stretch",
        }}
      >
        <div className="card" style={{ margin: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
              Submissions by person
            </h3>
          </div>
          <DonutChart data={donutData} />
        </div>

        <div className="card" style={{ margin: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
              Last 7 days
            </h3>
          </div>
          <MiniBars data={last7Days} />
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 1fr) minmax(280px, 360px)",
          gap: "14px",
          alignItems: "start",
        }}
      >
        <div className="card" style={{ margin: 0, paddingBottom: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
              Map coverage
            </h3>
          </div>
          <DashboardMap markers={markers} markerOwners={markerOwnerMap} />
        </div>

        <div className="card" style={{ margin: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
              Recent submissions
            </h3>
          </div>
          <div style={{ display: "grid", gap: "10px" }}>
            {recent.length === 0 ? (
              <div style={{ color: "#94a3b8", fontSize: "0.95rem" }}>Nothing yet.</div>
            ) : (
              recent.map((s) => {
                const ownerId = s.createdByUserId || "Unassigned";
                const ownerColor = colorForUser(ownerId);
                const contactUrl =
                  locationId && s.contactId
                    ? `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/contacts/detail/${encodeURIComponent(s.contactId)}`
                    : null;
                return (
                  <div
                    key={s.id}
                    style={{
                      padding: "10px 12px",
                      border: "1px solid #e2e8f0",
                      borderRadius: "10px",
                      background: "#fff",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 600, color: "#0f172a" }}>
                        {s.addressLabel || "No address label"}
                      </div>
                      <div style={{ display: "grid", gap: "2px", alignItems: "start", textAlign: "right" }}>
                        <div style={{ fontSize: "0.9rem", color: "#0f172a", fontWeight: 700 }}>Submission date/time</div>
                        <div style={{ fontSize: "0.9rem", color: "#475569" }}>
                          {s.createdAt ? new Date(s.createdAt).toLocaleString() : "—"}
                        </div>
                      </div>
                    </div>
                    <div style={{ marginTop: "6px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                      <span
                        className="badge-muted badge"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          borderColor: `${ownerColor}33`,
                          background: `${ownerColor}14`,
                          color: "#0f172a",
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            width: "8px",
                            height: "8px",
                            borderRadius: "999px",
                            background: ownerColor,
                          }}
                        />
                        {s.createdByUserId
                          ? `Driver: ${resolveUserName(ownerId, "User")}`
                          : "Unassigned"}
                      </span>
                      {contactUrl ? (
                        <a
                          href={contactUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                            padding: "6px 10px",
                            borderRadius: "8px",
                            background: "#2563eb",
                            color: "#fff",
                            fontWeight: 600,
                            textDecoration: "none",
                            boxShadow: "0 1px 2px rgba(37,99,235,0.24)",
                          }}
                        >
                          View Contact
                        </a>
                      ) : (
                        <span
                          className="badge-muted badge"
                          style={{ color: "#475569", background: "#f8fafc" }}
                        >
                          Contact not available
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
