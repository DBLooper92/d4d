"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import Image from "next/image";
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
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { getFirebaseFirestore, getFirebaseAuth } from "@/lib/firebaseClient";
import { getDocs } from "firebase/firestore";
import SkiptraceToggle from "./SkiptraceToggle";
import InviteList from "../invites/InviteList";
import QuickStartGuideContent from "./QuickStartGuideContent";
import logoImage from "../../../images/logo.png";

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

// Color priority: blue → green → yellow → purple → orange → red → remaining accents
const palette = [
  "#2563eb", // blue
  "#10b981", // green
  "#f59e0b", // yellow/amber
  "#8b5cf6", // purple
  "#f97316", // orange
  "#e11d48", // red
  "#0ea5e9", // cyan
  "#22c55e", // spring green
  "#14b8a6", // teal
  "#ec4899", // pink
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
type ManageUser = GhlUser & {
  firebaseUid?: string | null;
  active?: boolean;
  invited?: boolean;
  accepted?: boolean;
  isAdmin?: boolean;
  inviteStatus?: string | null;
};

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

function coordKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTime(value: number | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function formatMonthDay(value: number | null): string | null {
  if (!value) return null;
  return new Date(value).toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

function buildContactUrl(locationId: string, contactId: string | null): string | null {
  return locationId && contactId
    ? `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/contacts/detail/${encodeURIComponent(
        contactId,
      )}`
    : null;
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
type ActivityBar = {
  label: string;
  total: number;
  key?: string;
  segments: { id: string; value: number; color: string; name: string }[];
};

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
          {arcs.map((arc) => (
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

function MiniBars({ data }: { data: ActivityBar[] }) {
  const max = Math.max(...data.map((d) => d.total), 1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState<{ bar: ActivityBar; left: number; top: number } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [data]);

  function handleHover(bar: ActivityBar, e: MouseEvent<HTMLDivElement>) {
    const containerRect = containerRef.current?.getBoundingClientRect();
    const barRect = e.currentTarget.getBoundingClientRect();
    if (!containerRect) return;
    const centerX = barRect.left - containerRect.left + barRect.width / 2;
    const top = barRect.top - containerRect.top - 10;
    setHovered({ bar, left: centerX, top });
  }

  function handleLeave() {
    setHovered(null);
  }

  const tooltipWidth = 280;
  const tooltipLeft = (() => {
    if (!hovered || !containerRef.current) return 0;
    const containerWidth = containerRef.current.clientWidth;
    const raw = hovered.left - tooltipWidth / 2;
    const min = 8;
    const maxClamp = Math.max(min, containerWidth - tooltipWidth - 8);
    return Math.min(Math.max(raw, min), maxClamp);
  })();
  const tooltipTop = hovered ? Math.max(8, hovered.top) : 0;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <div
        ref={scrollRef}
        style={{
          overflowX: "auto",
          paddingBottom: "6px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: "10px",
            height: "140px",
            minWidth: `${Math.max(data.length * 48, 280)}px`,
          }}
        >
          {data.map((d) => {
            const barHeight = (d.total / max) * 120;
            const sorted = [...d.segments].sort((a, b) => b.value - a.value);
            return (
              <div
                key={d.key ?? d.label}
                style={{ flex: 1, textAlign: "center", display: "grid", gap: "4px" }}
                onMouseEnter={(e) => handleHover(d, e)}
                onMouseMove={(e) => handleHover(d, e)}
                onMouseLeave={handleLeave}
              >
                <div
                  style={{
                    position: "relative",
                    height: barHeight ? `${barHeight}px` : "6px",
                    borderRadius: "10px 10px 6px 6px",
                    overflow: "hidden",
                    boxShadow: d.total ? "0 6px 12px rgba(37, 99, 235, 0.18)" : "none",
                    background: d.total ? "#e2e8f0" : "linear-gradient(180deg, #e2e8f0, #cbd5e1)",
                    border: d.total ? "1px solid #e2e8f0" : "none",
                    display: "flex",
                    flexDirection: "column-reverse",
                    justifyContent: d.total ? "flex-start" : "center",
                  }}
                  aria-label={`${d.label}: ${d.total}`}
                >
                  {barHeight > 0
                    ? sorted.map((s) => {
                        const h = d.total ? (s.value / d.total) * barHeight : 0;
                        return (
                          <div
                            key={`${d.key ?? d.label}-${s.id}`}
                            style={{
                              height: `${h}px`,
                              background: s.color,
                            }}
                            aria-hidden="true"
                          />
                        );
                      })
                    : null}
                </div>
                <div style={{ fontSize: "11px", color: "#475569" }}>{d.label}</div>
              </div>
            );
          })}
        </div>
      </div>
      {hovered ? (
        <div
          style={{
            position: "absolute",
            left: tooltipLeft,
            top: tooltipTop,
            width: `${tooltipWidth}px`,
            maxWidth: "calc(100% - 16px)",
            background: "#fff",
            borderRadius: "12px",
            border: "1px solid #e2e8f0",
            boxShadow: "0 14px 36px rgba(15,23,42,0.18)",
            padding: "12px 14px",
            zIndex: 5,
            pointerEvents: "none",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
            <div style={{ color: "#0f172a", fontWeight: 700 }}>{hovered.bar.label}</div>
            <div style={{ color: "#0f172a", fontWeight: 700 }}>{hovered.bar.total} total</div>
          </div>
          {hovered.bar.segments.length ? (
            <div style={{ display: "grid", gap: "6px" }}>
              {[...hovered.bar.segments]
                .sort((a, b) => b.value - a.value)
                .map((s) => (
                  <div key={`${hovered.bar.label}-${s.id}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#0f172a" }}>
                      <span
                        aria-hidden="true"
                        style={{
                          width: "10px",
                          height: "10px",
                          borderRadius: "999px",
                          background: s.color,
                          boxShadow: "0 0 0 1px rgba(15,23,42,0.08)",
                        }}
                      />
                      <span style={{ fontWeight: 600 }}>{s.name}</span>
                    </div>
                    <span style={{ color: "#475569", fontWeight: 600 }}>{s.value}</span>
                  </div>
                ))}
            </div>
          ) : (
            <div style={{ color: "#94a3b8", fontSize: "0.95rem" }}>No submissions</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

type DashboardMapProps = {
  markers: MarkerDoc[];
  markerOwners: Map<string, string>;
  submissionLookup: Map<string, SubmissionDoc>;
  resolveUserName: (id: string | null | undefined, fallbackPrefix?: string) => string;
  locationId: string;
};

function DashboardMap({ markers, markerOwners, submissionLookup, resolveUserName, locationId }: DashboardMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRefs = useRef<maplibregl.Marker[]>([]);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const buildPopupContent = useCallback(
    (submission: SubmissionDoc | null, ownerColor: string): string => {
    if (!submission) {
      return `<div style="padding:12px 14px; max-width:320px; font-family:Inter, system-ui, -apple-system, sans-serif; color:#0f172a;">
        <div style="font-weight:700; font-size:1.05rem; margin-bottom:4px;">No submission details</div>
        <div style="color:#475569;">This marker has no linked submission.</div>
      </div>`;
    }

    const ownerLabel = submission.createdByUserId
      ? `Driver: ${escapeHtml(resolveUserName(submission.createdByUserId, "User"))}`
      : "Unassigned";
    const contactUrl = buildContactUrl(locationId, submission.contactId);
    const address = escapeHtml(submission.addressLabel || "No address label");

    return `<div style="padding:12px 14px; max-width:360px; font-family:Inter, system-ui, -apple-system, sans-serif; color:#0f172a;">
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start; margin-bottom:6px;">
        <div style="font-weight:700; font-size:1.05rem; line-height:1.3;">${address}</div>
        <div style="display:grid; gap:2px; text-align:right; font-size:0.9rem;">
          <div style="color:#0f172a; font-weight:700;">Submission date/time</div>
          <div style="color:#475569;">${escapeHtml(formatDateTime(submission.createdAt))}</div>
        </div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:6px;">
        <span style="display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:20px; border:1px solid ${ownerColor}33; background:${ownerColor}14; color:#0f172a; font-weight:600;">
          <span aria-hidden="true" style="width:8px; height:8px; border-radius:999px; background:${ownerColor};"></span>
          ${escapeHtml(ownerLabel)}
        </span>
        ${
          contactUrl
            ? `<a href="${contactUrl}" target="_blank" rel="noreferrer"
                style="display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:8px; background:#2563eb; color:#fff; font-weight:700; text-decoration:none; box-shadow:0 1px 2px rgba(37,99,235,0.24);">
                View Contact
              </a>`
            : `<span style="display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:12px; border:1px solid #e2e8f0; background:#f8fafc; color:#475569;">Contact not available</span>`
        }
      </div>
    </div>`;
    },
    [locationId, resolveUserName],
  );

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
      center: [-98.5795, 39.8283],
      zoom: 3.5,
      attributionControl: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showCompass: false }), "top-right");
    return () => {
      markerRefs.current.forEach((m) => m.remove());
      markerRefs.current = [];
      popupRef.current?.remove();
      popupRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markerRefs.current.forEach((m) => m.remove());
    markerRefs.current = [];
    popupRef.current?.remove();
    popupRef.current = null;
    if (!markers.length) {
      map.easeTo({ center: [-98.5795, 39.8283], zoom: 3.5, duration: 400 });
      return;
    }

    const bounds = new maplibregl.LngLatBounds();
    markers.forEach((m) => {
      bounds.extend([m.lng, m.lat]);
      const key = coordKey(m.lat, m.lng);
      const ownerId = (m.createdByUserId || "").trim() || markerOwners.get(key) || "Unassigned";
      const markerColor = colorForUser(ownerId);
      const marker = new maplibregl.Marker({ color: markerColor })
        .setLngLat([m.lng, m.lat])
        .addTo(map);

      marker.getElement().addEventListener("click", () => {
        const submission = submissionLookup.get(key) ?? null;
        const html = buildPopupContent(submission, markerColor);

        popupRef.current?.remove();
        const popup = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: false,
          offset: 12,
        })
          .setLngLat([m.lng, m.lat])
          .setHTML(html)
          .addTo(map);

        popupRef.current = popup;
        popup.on("close", () => {
          if (popupRef.current === popup) {
            popupRef.current = null;
          }
        });
      });

      markerRefs.current.push(marker);
    });

    if (markers.length === 1) {
      map.easeTo({ center: [markers[0].lng, markers[0].lat], zoom: 13, duration: 500 });
    } else {
      map.fitBounds(bounds, { padding: 40, maxZoom: 12, duration: 600 });
    }
  }, [markers, markerOwners, submissionLookup, resolveUserName, locationId, buildPopupContent]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "640px",
        borderRadius: "12px",
        overflow: "hidden",
        border: "1px solid #e2e8f0",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}
    />
  );
}

export default function DashboardInsights({ locationId }: Props) {
  const { submissions: allSubmissions, markers: allMarkers } = useLocationStreams(locationId);
  const [timeRangeDays, setTimeRangeDays] = useState<number>(14);
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [userMeta, setUserMeta] = useState<
    Record<string, { active?: boolean; invited?: boolean; accepted?: boolean; isAdmin?: boolean }>
  >({});
  const [showInviteModal, setShowInviteModal] = useState<boolean>(false);
  const [showQuickStart, setShowQuickStart] = useState<boolean>(false);
  const [showIndustrySettings, setShowIndustrySettings] = useState<boolean>(false);
  const [showQuickStartCta, setShowQuickStartCta] = useState<boolean>(true);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState<boolean>(false);
  const [skipTracesAvailable, setSkipTracesAvailable] = useState<number | null>(null);
  const [skipTraceRefreshAt, setSkipTraceRefreshAt] = useState<number | null>(null);
  const [skipTraceInfoLoading, setSkipTraceInfoLoading] = useState<boolean>(true);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const auth = useMemo(() => getFirebaseAuth(), []);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [viewer, setViewer] = useState<{ loading: boolean; isAdmin: boolean; ghlUserId: string | null }>({
    loading: true,
    isAdmin: false,
    ghlUserId: null,
  });
  const canManageLocation = viewer.isAdmin;
  const showSkiptrace = true;
  const skipTraceRefreshLabel = useMemo(() => formatMonthDay(skipTraceRefreshAt), [skipTraceRefreshAt]);

  const openInviteModal = useCallback(() => {
    if (!canManageLocation) return;
    setShowInviteModal(true);
  }, [canManageLocation]);
  const closeInviteModal = useCallback(() => setShowInviteModal(false), []);
  const openQuickStart = useCallback(() => {
    setShowIndustrySettings(false);
    setShowQuickStart(true);
  }, []);
  const closeQuickStart = useCallback(() => setShowQuickStart(false), []);
  const openIndustrySettings = useCallback(() => {
    if (!canManageLocation) return;
    setShowQuickStart(false);
    setShowIndustrySettings(true);
  }, [canManageLocation]);
  const closeIndustrySettings = useCallback(() => setShowIndustrySettings(false), []);

  useEffect(() => {
    if (!showInviteModal && !showQuickStart && !showIndustrySettings) return;
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") {
        setShowInviteModal(false);
        setShowQuickStart(false);
        setShowIndustrySettings(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showInviteModal, showQuickStart, showIndustrySettings]);

  useEffect(() => {
    try {
      const stored =
        typeof window !== "undefined"
          ? window.localStorage.getItem("d4d:showQuickStartCta")
          : null;
      if (stored === "0") {
        setShowQuickStartCta(false);
      }
    } catch {
      /* ignore preference read errors */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("d4d:showQuickStartCta", showQuickStartCta ? "1" : "0");
    } catch {
      /* ignore preference write errors */
    }
  }, [showQuickStartCta]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handleClick = (evt: globalThis.MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(evt.target as Node)) {
        setSettingsOpen(false);
      }
    };
    const handleKey = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [settingsOpen]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setAuthUser(u);
      setAuthReady(true);
    });
    return () => unsub();
  }, [auth]);

  useEffect(() => {
    let cancelled = false;
    async function loadViewer() {
      if (!authReady) return;
      if (!locationId || !authUser) {
        if (!cancelled) {
          setViewer({ loading: false, isAdmin: false, ghlUserId: null });
        }
        return;
      }

      setViewer((prev) => ({ ...prev, loading: true }));
      try {
        const db = getFirebaseFirestore();
        let locationAdminUid: string | null = null;
        let locationAdminGhlUserId: string | null = null;
        try {
          const locRootSnap = await getDoc(doc(db, "locations", locationId));
          if (locRootSnap.exists()) {
            const rootData = (locRootSnap.data() || {}) as { adminUid?: unknown; adminGhlUserId?: unknown };
            if (typeof rootData.adminUid === "string" && rootData.adminUid.trim()) {
              locationAdminUid = rootData.adminUid.trim();
            }
            if (typeof rootData.adminGhlUserId === "string" && rootData.adminGhlUserId.trim()) {
              locationAdminGhlUserId = rootData.adminGhlUserId.trim();
            }
          }
        } catch {
          /* ignore location root read errors */
        }

        let locData: Record<string, unknown> | null = null;
        try {
          const locSnap = await getDoc(doc(db, "locations", locationId, "users", authUser.uid));
          locData = locSnap.exists() ? ((locSnap.data() || {}) as Record<string, unknown>) : {};
        } catch {
          // Keep going with other sources if Firestore denies this read for any reason.
          locData = null;
        }

        const locRole = (locData as { role?: string } | null)?.role;
        let isAdmin =
          Boolean((locData as { isAdmin?: boolean } | null)?.isAdmin) ||
          (typeof locRole === "string" && locRole.trim().toLowerCase() === "admin");
        let ghlUserId = locData ? extractGhlUserId(locData) : "";

        try {
          const rootSnap = await getDoc(doc(db, "users", authUser.uid));
          if (rootSnap.exists()) {
            const rootData = (rootSnap.data() || {}) as Record<string, unknown>;
            const rootRole = (rootData as { role?: string }).role;
            if (!isAdmin) {
              isAdmin =
                Boolean((rootData as { isAdmin?: boolean }).isAdmin) ||
                (typeof rootRole === "string" && rootRole.trim().toLowerCase() === "admin");
            }
            if (!ghlUserId) {
              ghlUserId = extractGhlUserId(rootData);
            }
          }
        } catch {
          /* ignore root user read errors */
        }

        // Server-side source of truth: rely on manage endpoint's self entry.
        try {
          const token = await authUser.getIdToken();
          const qs = new URLSearchParams({ location_id: locationId });
          if (token) qs.set("idToken", token);
          const resp = await fetch(`/api/location-users/manage?${qs.toString()}`, {
            cache: "no-store",
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          });
          const parsed = (await resp.json().catch(() => ({}))) as
            | { users?: ManageUser[]; adminGhlUserId?: string | null; error?: string }
            | { data?: { users?: ManageUser[] }; adminGhlUserId?: string | null; error?: string };
          if (resp.ok && !(parsed as { error?: string }).error) {
            const users = (parsed as { users?: ManageUser[] }).users ??
              (parsed as { data?: { users?: ManageUser[] } }).data?.users ??
              [];
            const adminGhlUserId = (parsed as { adminGhlUserId?: string | null }).adminGhlUserId ?? null;
            const selfEntry = users.find((u) => u.firebaseUid === authUser.uid);
            if (!ghlUserId && selfEntry?.id) {
              ghlUserId = selfEntry.id;
            }
            const isSelfAdmin = Boolean(selfEntry?.isAdmin);
            const adminByGhlId =
              adminGhlUserId && selfEntry?.id && adminGhlUserId === selfEntry.id;
            if (isSelfAdmin || adminByGhlId) {
              isAdmin = true;
            } else if (selfEntry && selfEntry.isAdmin === false) {
              // Explicit false from server wins.
              isAdmin = false;
            }
          }
        } catch {
          /* ignore manage fallback errors */
        }

        if (locationAdminUid) {
          if (locationAdminUid === authUser.uid) {
            isAdmin = true;
          } else {
            isAdmin = false;
          }
        }
        if (locationAdminGhlUserId) {
          if (ghlUserId && locationAdminGhlUserId === ghlUserId) {
            isAdmin = true;
          } else if (isAdmin && ghlUserId && locationAdminGhlUserId !== ghlUserId) {
            isAdmin = false;
          }
          if (!ghlUserId && isAdmin) {
            ghlUserId = locationAdminGhlUserId;
          }
        }

        if (!cancelled) {
          setViewer({
            loading: false,
            isAdmin,
            ghlUserId: ghlUserId || null,
          });
        }
      } catch {
        if (!cancelled) {
          setViewer({ loading: false, isAdmin: false, ghlUserId: null });
        }
      }
    }
    void loadViewer();
    return () => {
      cancelled = true;
    };
  }, [authReady, authUser, locationId]);

  useEffect(() => {
    let cancelled = false;
    async function loadSkiptraceInfo() {
      if (!locationId || !authReady) {
        setSkipTracesAvailable(null);
        setSkipTraceRefreshAt(null);
        setSkipTraceInfoLoading(false);
        return;
      }

      if (!authUser) {
        setSkipTracesAvailable(null);
        setSkipTraceRefreshAt(null);
        setSkipTraceInfoLoading(false);
        return;
      }

      setSkipTracesAvailable(null);
      setSkipTraceRefreshAt(null);
      setSkipTraceInfoLoading(true);

      try {
        const token = await authUser.getIdToken();
        const res = await fetch(`/api/locations/skiptrace?locationId=${encodeURIComponent(locationId)}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as {
          skipTracesAvailable?: unknown;
          skipTraceRefresh?: unknown;
          error?: string;
        };
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

        if (!cancelled) {
          setSkipTracesAvailable(available);
          setSkipTraceRefreshAt(refreshAt);
          setSkipTraceInfoLoading(false);
        }
      } catch (error) {
        console.error("Failed to load skiptrace info:", error);
        if (!cancelled) {
          setSkipTracesAvailable(null);
          setSkipTraceRefreshAt(null);
          setSkipTraceInfoLoading(false);
        }
      }
    }

    void loadSkiptraceInfo();
    return () => {
      cancelled = true;
    };
  }, [authReady, authUser, locationId]);

  useEffect(() => {
    // Ensure admin metadata exists so the Drivers section always shows admin as active.
    if (!viewer.isAdmin) return;
    setUserMeta((prev) => {
      const next = { ...prev };
      let changed = false;
      const setAdmin = (id: string | null | undefined) => {
        const key = (id || "").trim();
        if (!key) return;
        const current = next[key] || {};
        const updated = { ...current, isAdmin: true, active: true, invited: true, accepted: true };
        if (JSON.stringify(updated) !== JSON.stringify(current)) {
          next[key] = updated;
          changed = true;
        }
      };
      setAdmin(viewer.ghlUserId);
      setAdmin(authUser?.uid);
      return changed ? next : prev;
    });
  }, [viewer.isAdmin, viewer.ghlUserId, authUser?.uid]);

  useEffect(() => {
    if (!viewer.isAdmin) {
      setShowInviteModal(false);
      setShowQuickStart(false);
      setShowIndustrySettings(false);
    }
  }, [viewer.isAdmin]);

  const toggleSettings = useCallback(() => {
    setSettingsError(null);
    setSettingsOpen((prev) => !prev);
  }, []);

  const handleQuickStartVisibilityChange = useCallback((checked: boolean) => {
    setSettingsError(null);
    setShowQuickStartCta(checked);
  }, []);

  const handleOpenIndustrySettings = useCallback(() => {
    if (!canManageLocation) return;
    setSettingsOpen(false);
    openIndustrySettings();
  }, [canManageLocation, openIndustrySettings]);

  const handleSignOut = useCallback(async () => {
    setSettingsError(null);
    setSigningOut(true);
    try {
      await signOut(auth);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Failed to sign out.");
    } finally {
      setSigningOut(false);
      setSettingsOpen(false);
    }
  }, [auth]);

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
        setUserMeta({});
        return;
      }
      try {
        const map: Record<string, string> = {};
        const meta: Record<string, { active?: boolean; invited?: boolean; accepted?: boolean; isAdmin?: boolean }> =
          {};

        const storeMeta = (id: string | null | undefined, data: typeof meta[string]) => {
          const key = (id || "").trim();
          if (!key) return;
          const existing = meta[key] || {};
          meta[key] = { ...existing, ...data };
        };

        // 1) Authenticated manage endpoint (includes firebaseUid)
        try {
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
            const isAdmin = Boolean(u.isAdmin);
            const active = Boolean(u.active || isAdmin);
            const invited = Boolean(u.invited);
            const accepted = Boolean(u.accepted);
            const payload = { active: active || isAdmin, invited, accepted, isAdmin };
            storeMeta(u.id, payload);
            storeMeta(u.firebaseUid, payload);
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

        if (!cancelled) {
          setUserNames(map);
          setUserMeta(meta);
        }
      } catch {
        if (!cancelled) {
          setUserNames({});
          setUserMeta((prev) => prev);
        }
      }
    }
    void loadUsers();
    return () => {
      cancelled = true;
    };
  }, [locationId, auth]);

  useEffect(() => {
    if (!locationId) return;

    const uniqueIds = Array.from(
      new Set(
        allSubmissions
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
  }, [locationId, allSubmissions, userNames]);

  const ownerIds = useMemo(() => {
    const ids: string[] = [];
    if (viewer.ghlUserId) ids.push(viewer.ghlUserId.trim());
    if (authUser?.uid) ids.push(authUser.uid);
    return Array.from(new Set(ids.filter(Boolean)));
  }, [viewer.ghlUserId, authUser?.uid]);

  // Limit visibility to the current user unless they are an admin.
  const visibleSubmissions = useMemo(() => {
    if (viewer.isAdmin) return allSubmissions;
    const allowed = new Set(ownerIds.map((id) => id.trim()).filter(Boolean));
    if (!allowed.size) return [];
    return allSubmissions.filter((s) => allowed.has((s.createdByUserId || "").trim()));
  }, [allSubmissions, viewer.isAdmin, ownerIds]);

  const allowedCoordKeys = useMemo(() => {
    if (viewer.isAdmin) return new Set<string>();
    const keys = new Set<string>();
    visibleSubmissions.forEach((s) => {
      if (!s.coordinates) return;
      keys.add(coordKey(s.coordinates.lat, s.coordinates.lng));
    });
    return keys;
  }, [viewer.isAdmin, visibleSubmissions]);

  const visibleMarkers = useMemo(() => {
    if (viewer.isAdmin) return allMarkers;
    const allowed = new Set(ownerIds.map((id) => id.trim()).filter(Boolean));
    if (!allowed.size) return [];
    return allMarkers.filter((m) => {
      const owner = (m.createdByUserId || "").trim();
      if (owner && allowed.has(owner)) return true;
      const key = coordKey(m.lat, m.lng);
      return allowedCoordKeys.has(key);
    });
  }, [allMarkers, viewer.isAdmin, ownerIds, allowedCoordKeys]);

  const donutData = useMemo<DonutDatum[]>(() => {
    const grouped = new Map<string, number>();
    visibleSubmissions.forEach((s) => {
      const key = s.createdByUserId || "Unassigned";
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    });
    const entries = Array.from(grouped.entries()).sort((a, b) => b[1] - a[1]);
    return entries.map(([label, value]) => ({
      label: resolveUserName(label),
      value,
      color: colorForUser(label),
    }));
  }, [visibleSubmissions, resolveUserName]);

  const activitySeries = useMemo<ActivityBar[]>(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days: ActivityBar[] = [];
    for (let i = timeRangeDays - 1; i >= 0; i -= 1) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const label =
        timeRangeDays <= 14
          ? d.toLocaleDateString(undefined, { weekday: "short" })
          : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const perUser = new Map<string, number>();
      visibleSubmissions.forEach((s) => {
        if (!s.createdAt) return;
        const dayKey = new Date(s.createdAt).toISOString().slice(0, 10);
        if (dayKey !== key) return;
        const ownerId = (s.createdByUserId || "Unassigned").trim() || "Unassigned";
        perUser.set(ownerId, (perUser.get(ownerId) ?? 0) + 1);
      });
      const total = Array.from(perUser.values()).reduce((sum, v) => sum + v, 0);
      const segments = Array.from(perUser.entries()).map(([id, value]) => ({
        id,
        value,
        color: colorForUser(id),
        name: resolveUserName(id),
      }));
      days.push({ label, total, key, segments });
    }
    return days;
  }, [visibleSubmissions, timeRangeDays, resolveUserName]);

  const activitySummary = useMemo(() => {
    const total = activitySeries.reduce((sum, d) => sum + d.total, 0);
    const peak =
      activitySeries.reduce<{ label: string; value: number } | null>(
        (top, d) => (!top || d.total > top.value ? { label: d.label, value: d.total } : top),
        null,
      ) ?? { label: "—", value: 0 };
    const avg = timeRangeDays ? total / timeRangeDays : 0;
    return { total, avg, peak };
  }, [activitySeries, timeRangeDays]);

  const rangeLabel = useMemo(() => {
    if (timeRangeDays === 7) return "Last 7 days";
    if (timeRangeDays === 14) return "Last 14 days";
    if (timeRangeDays === 30) return "Last 30 days";
    return `Last ${timeRangeDays} days`;
  }, [timeRangeDays]);

  const recent = useMemo(() => visibleSubmissions.slice(0, 6), [visibleSubmissions]);

  const markerOwnerMap = useMemo(() => {
    const map = new Map<string, string>();
    visibleSubmissions.forEach((s) => {
      if (!s.coordinates) return;
      const owner = (s.createdByUserId || "").trim();
      if (!owner) return;
      const key = coordKey(s.coordinates.lat, s.coordinates.lng);
      if (!map.has(key)) map.set(key, owner);
    });
    return map;
  }, [visibleSubmissions]);

  const submissionLookup = useMemo(() => {
    const map = new Map<string, SubmissionDoc>();
    visibleSubmissions.forEach((s) => {
      if (!s.coordinates) return;
      const key = coordKey(s.coordinates.lat, s.coordinates.lng);
      if (!map.has(key)) {
        map.set(key, s);
      }
    });
    return map;
  }, [visibleSubmissions]);

  const userColorGuide = useMemo(() => {
    const allowedIds = new Set(
      Object.entries(userMeta)
        .filter(([, m]) => m.isAdmin || m.invited || m.accepted)
        .map(([id]) => id.trim())
        .filter(Boolean),
    );

    const submissionCounts = new Map<string, number>();
    visibleSubmissions.forEach((s) => {
      const id = (s.createdByUserId || "Unassigned").trim() || "Unassigned";
      submissionCounts.set(id, (submissionCounts.get(id) ?? 0) + 1);
    });

    const entries = new Map<string, { id: string; name: string; color: string; count: number; active: boolean }>();
    const addEntry = (id: string, count: number) => {
      const name = resolveUserName(id);
      const key = name.toLowerCase();
      if (!allowedIds.has(id.trim())) return;
      const existing = entries.get(key);
      const meta = userMeta[id] || {};
      const active = meta.active ?? (meta.isAdmin ? true : count > 0);
      if (!existing || count > existing.count || (active && !existing.active)) {
        entries.set(key, { id, name, color: colorForUser(id), count, active });
      }
    };

    submissionCounts.forEach((count, id) => {
      if (!allowedIds.has(id.trim())) return;
      addEntry(id, count);
    });

    allowedIds.forEach((id) => {
      const count = submissionCounts.get(id) ?? 0;
      addEntry(id, count);
    });

    return Array.from(entries.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
  }, [visibleSubmissions, userMeta, resolveUserName]);

  return (
    <>
      <section className="card" style={{ marginTop: "1.5rem", display: "grid", gap: "1rem" }}>
        <div
          className="dashboard-header"
          style={{
            display: "grid",
            gridTemplateColumns: "var(--dashboard-header-columns, minmax(0, 1fr) auto minmax(0, 1fr))",
            alignItems: "center",
            gap: "1rem",
          }}
        >
          <div style={{ display: "grid", gap: "10px", minWidth: "0" }}>
            <div ref={settingsRef} style={{ position: "relative", justifySelf: "start" }}>
              <button
                type="button"
                onClick={toggleSettings}
                aria-expanded={settingsOpen}
                aria-haspopup="true"
                aria-label="Open settings"
                style={{
                  width: "24px",
                  height: "24px",
                  borderRadius: 0,
                  border: "none",
                  background: "transparent",
                  color: "#0f172a",
                  fontWeight: 700,
                  boxShadow: "none",
                  cursor: "pointer",
                  display: "grid",
                  placeItems: "center",
                  padding: 0,
                }}
              >
                <svg
                  aria-hidden="true"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#0f172a"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01A1.65 1.65 0 0 0 9 3.09V3a2 2 0 1 1 4 0v.09c0 .69.4 1.31 1.02 1.59h0a1.65 1.65 0 0 0 1.81-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01c.28.62.9 1.02 1.59 1.02H21a2 2 0 0 1 0 4h-.09c-.69 0-1.31.4-1.59 1.02Z" />
                </svg>
              </button>
              {settingsOpen ? (
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "calc(100% + 12px)",
                    width: "min(360px, 92vw)",
                    background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",
                    border: "1px solid #e2e8f0",
                    borderRadius: "16px",
                    boxShadow: "0 20px 48px rgba(15,23,42,0.18)",
                    padding: "14px",
                    zIndex: 20,
                    display: "grid",
                    gap: "12px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
                    <div style={{ display: "grid", gap: "4px" }}>
                      <div style={{ fontWeight: 800, color: "#0f172a", fontSize: "1rem" }}>
                        Dashboard settings
                      </div>
                      <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
                        Control onboarding prompts and your account.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSettingsOpen(false)}
                      aria-label="Close settings"
                      style={{
                        width: "32px",
                        height: "32px",
                        borderRadius: "10px",
                        border: "1px solid #e2e8f0",
                        background: "#fff",
                        cursor: "pointer",
                        display: "grid",
                        placeItems: "center",
                        color: "#0f172a",
                        fontWeight: 800,
                        boxShadow: "0 4px 10px rgba(15,23,42,0.08)",
                      }}
                    >
                      X
                    </button>
                  </div>
                  {settingsError ? (
                    <div
                      style={{
                        background: "#fff1f2",
                        border: "1px solid #fecaca",
                        color: "#b91c1c",
                        borderRadius: "12px",
                        padding: "8px 10px",
                        fontSize: "0.95rem",
                      }}
                    >
                      {settingsError}
                    </div>
                  ) : null}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "12px",
                      padding: "10px 12px",
                      borderRadius: "12px",
                      border: "1px solid #e2e8f0",
                      background: "#fff",
                      boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
                      opacity: canManageLocation ? 1 : 0.6,
                    }}
                  >
                    <div style={{ display: "grid", gap: "4px" }}>
                      <span style={{ fontWeight: 700, color: "#0f172a" }}>Show GET STARTED button</span>
                      <span style={{ color: "#94a3b8", fontSize: "0.9rem" }}>
                        Hide the banner if your team is already set up.
                      </span>
                    </div>
                    <input
                      type="checkbox"
                      checked={showQuickStartCta}
                      onChange={(e) => handleQuickStartVisibilityChange(e.target.checked)}
                      disabled={!canManageLocation}
                      aria-label="Toggle Get Started visibility"
                      style={{
                        width: "18px",
                        height: "18px",
                        cursor: canManageLocation ? "pointer" : "not-allowed",
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleOpenIndustrySettings}
                    disabled={!canManageLocation}
                    style={{
                      padding: "10px 12px",
                      borderRadius: "12px",
                      border: "1px solid #38bdf8",
                      background: canManageLocation ? "linear-gradient(120deg, #01B9FA, #2563eb)" : "#e2e8f0",
                      color: canManageLocation ? "#fff" : "#94a3b8",
                      fontWeight: 700,
                      cursor: canManageLocation ? "pointer" : "not-allowed",
                      boxShadow: canManageLocation ? "0 10px 22px rgba(37,99,235,0.2)" : "none",
                      textAlign: "left",
                      width: "100%",
                    }}
                  >
                    Select industry & quick notes
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSignOut()}
                    disabled={signingOut}
                    style={{
                      padding: "10px 12px",
                      borderRadius: "12px",
                      border: "1px solid #fecaca",
                      background: signingOut ? "#fee2e2" : "linear-gradient(120deg, #ef4444, #dc2626)",
                      color: "#fff",
                      fontWeight: 800,
                      cursor: signingOut ? "not-allowed" : "pointer",
                      boxShadow: signingOut ? "none" : "0 10px 22px rgba(239,68,68,0.2)",
                      textAlign: "left",
                      width: "100%",
                    }}
                  >
                    {signingOut ? "Signing out..." : "Sign out"}
                  </button>
                </div>
              ) : null}
            </div>
            {canManageLocation ? (
              <button
                type="button"
                onClick={openQuickStart}
                aria-hidden={!showQuickStartCta}
                tabIndex={showQuickStartCta ? 0 : -1}
                style={{
                  padding: "0.5rem 0.9rem",
                  borderRadius: "12px",
                  background: "#facc15",
                  color: "#0f172a",
                  fontWeight: 800,
                  letterSpacing: "0.02em",
                  border: "1px solid #eab308",
                  boxShadow: "0 8px 14px rgba(250, 204, 21, 0.3)",
                  cursor: showQuickStartCta ? "pointer" : "default",
                  textTransform: "uppercase",
                  width: "fit-content",
                  minWidth: "140px",
                  textAlign: "center",
                  visibility: showQuickStartCta ? "visible" : "hidden",
                  pointerEvents: showQuickStartCta ? "auto" : "none",
                }}
              >
                GET STARTED
              </button>
            ) : null}
            {!viewer.isAdmin && !viewer.loading ? (
              <div
                className="badge"
                style={{
                  alignSelf: "flex-start",
                  background: "#f0f9ff",
                  color: "#0f172a",
                  borderColor: "#bae6fd",
                  fontWeight: 700,
                  justifySelf: "start",
                }}
              >
                Showing your submissions
              </div>
            ) : null}
          </div>
          <div
            style={{
              display: "grid",
              alignItems: "center",
              justifyItems: "center",
              gap: "0.65rem",
              minWidth: "200px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Image
                src={logoImage}
                alt="Driving4Dollars.co logo"
                width={32}
                height={32}
                style={{ objectFit: "contain", filter: "drop-shadow(0 8px 18px rgba(1,185,250,0.3))" }}
              />
              <span style={{ color: "#01B9FA", fontWeight: 800, letterSpacing: "0.02em", fontSize: "1.05rem" }}>
                Driving4Dollars.co
              </span>
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gap: "0.5rem",
              justifyItems: "end",
              minWidth: "0",
            }}
          >
            {canManageLocation && showSkiptrace ? (
              <div
                style={{
                  display: "grid",
                  gap: "0.35rem",
                  width: "220px",
                  minWidth: "180px",
                  maxWidth: "240px",
                  textAlign: "right",
                  justifySelf: "end",
                }}
              >
                <SkiptraceToggle locationId={locationId} />
                {skipTraceInfoLoading ? (
                  <div style={{ display: "grid", gap: "6px", justifyItems: "end" }}>
                    <div className="skel" style={{ width: "200px", height: "12px" }} />
                    <div className="skel" style={{ width: "160px", height: "12px" }} />
                  </div>
                ) : (
                  <div style={{ margin: 0, color: "#475569", fontSize: "0.9rem", display: "grid", gap: "2px" }}>
                    <div>Remaining - {skipTracesAvailable ?? "--"}/150</div>
                    <div>Refreshes - {skipTraceRefreshLabel ?? "--"}</div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "12px",
        }}
      >
        <div className="card" style={{ margin: 0, borderColor: "#e2e8f0" }}>
          <div style={{ color: "#475569", fontSize: "0.9rem", fontWeight: 600 }}>Total submissions</div>
          <div style={{ fontSize: "2rem", fontWeight: 700, color: "#0f172a" }}>{visibleSubmissions.length}</div>
          <div style={{ color: "#64748b", marginTop: "4px" }}>All time</div>
        </div>
        <div className="card" style={{ margin: 0, borderColor: "#e2e8f0" }}>
          <div style={{ color: "#475569", fontSize: "0.9rem", fontWeight: 600 }}>Active markers</div>
          <div style={{ fontSize: "2rem", fontWeight: 700, color: "#0f172a" }}>{visibleMarkers.length}</div>
          <div style={{ color: "#64748b", marginTop: "4px" }}>Currently visible on map</div>
        </div>
        <div className="card" style={{ margin: 0, borderColor: "#e2e8f0" }}>
          <div style={{ color: "#475569", fontSize: "0.9rem", fontWeight: 600 }}>Recent activity</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <div>
              <div style={{ fontSize: "2rem", fontWeight: 700, color: "#0f172a" }}>{activitySummary.total}</div>
              <div style={{ color: "#64748b", marginTop: "4px" }}>{rangeLabel}</div>
            </div>
            <div style={{ textAlign: "right", color: "#475569", fontSize: "0.95rem" }}>
              <div style={{ fontWeight: 700 }}>Avg {activitySummary.avg.toFixed(1)} / day</div>
              <div style={{ color: "#64748b" }}>Peak: {activitySummary.peak.value} on {activitySummary.peak.label}</div>
            </div>
          </div>
        </div>
      </div>

      {canManageLocation ? (
        <div className="card" style={{ margin: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", gap: "10px", flexWrap: "wrap" }}>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>Drivers</h3>
            <button
              type="button"
              className="btn primary"
              onClick={openInviteModal}
              style={{
                padding: "0.5rem 0.9rem",
                borderRadius: "10px",
                fontWeight: 700,
                background: "#01B9FA",
                color: "#fff",
                boxShadow: "0 8px 16px rgba(1,185,250,0.24)",
                cursor: "pointer",
              }}
            >
              Invite Drivers
            </button>
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
                    <div style={{ fontWeight: 600, color: u.active ? "#0f172a" : "#94a3b8" }}>{u.name}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.85rem" }}>
                      <span style={{ color: "#475569" }}>{u.count} submission{u.count === 1 ? "" : "s"}</span>
                      {!u.active && (
                        <span style={{ color: "#94a3b8", fontWeight: 600 }}>(inactive)</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: "#94a3b8", fontSize: "0.95rem" }}>No users yet.</div>
          )}
        </div>
      ) : null}

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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", gap: "8px", flexWrap: "wrap" }}>
            <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
              Activity
            </h3>
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              {[7, 14, 30].map((d) => {
                const active = timeRangeDays === d;
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setTimeRangeDays(d)}
                    style={{
                      padding: "6px 10px",
                      borderRadius: "10px",
                      border: active ? "1px solid #2563eb" : "1px solid #e2e8f0",
                      background: active ? "#eff6ff" : "#fff",
                      color: active ? "#1d4ed8" : "#475569",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {d}d
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ color: "#64748b", fontSize: "0.9rem", marginBottom: "6px" }}>{rangeLabel}</div>
          <MiniBars data={activitySeries} />
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
          <DashboardMap
            markers={visibleMarkers}
            markerOwners={markerOwnerMap}
            submissionLookup={submissionLookup}
            resolveUserName={resolveUserName}
            locationId={locationId}
          />
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
      {canManageLocation && showIndustrySettings && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Industry settings"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeIndustrySettings();
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(15,23,42,0.55)",
            backdropFilter: "blur(4px)",
            display: "grid",
            placeItems: "center",
            padding: "20px",
          }}
        >
          <div
            style={{
              width: "min(980px, 96vw)",
              maxHeight: "90vh",
              background: "#fff",
              borderRadius: "18px",
              overflow: "hidden",
              border: "1px solid #e2e8f0",
              boxShadow: "0 24px 70px rgba(15,23,42,0.35)",
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
                background: "#f8fafc",
              }}
            >
              <div>
                <div style={{ color: "#0f172a", fontWeight: 700, fontSize: "1.05rem" }}>
                  Industry & quick notes
                </div>
                <div style={{ color: "#475569", marginTop: "2px" }}>
                  Update the defaults shown to drivers in the mobile app.
                </div>
              </div>
              <button
                type="button"
                onClick={closeIndustrySettings}
                aria-label="Close industry settings"
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
            <div style={{ padding: "16px 16px 18px", overflow: "auto" }}>
              <QuickStartGuideContent locationId={locationId} mode="settings" />
            </div>
          </div>
        </div>
      )}
      {canManageLocation && showQuickStart && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Quick start guide"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeQuickStart();
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(15,23,42,0.55)",
            backdropFilter: "blur(4px)",
            display: "grid",
            placeItems: "center",
            padding: "20px",
          }}
        >
          <div
            style={{
              width: "min(900px, 95vw)",
              maxHeight: "90vh",
              background: "#fff",
              borderRadius: "16px",
              overflow: "hidden",
              border: "1px solid #e2e8f0",
              boxShadow: "0 24px 70px rgba(15,23,42,0.35)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: "12px",
                padding: "14px 16px",
                borderBottom: "1px solid #e2e8f0",
                background: "#f8fafc",
              }}
            >
              <button
                type="button"
                onClick={closeQuickStart}
                aria-label="Close quick start guide"
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
            <div style={{ padding: "16px 16px 18px", overflow: "auto" }}>
              <QuickStartGuideContent locationId={locationId} />
            </div>
          </div>
        </div>
      )}
      {canManageLocation && showInviteModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Invite drivers"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeInviteModal();
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            background: "rgba(15,23,42,0.55)",
            backdropFilter: "blur(4px)",
            display: "grid",
            placeItems: "center",
            padding: "20px",
          }}
        >
          <div
            style={{
              width: "min(1100px, 96vw)",
              maxHeight: "90vh",
              background: "#fff",
              borderRadius: "18px",
              overflow: "hidden",
              border: "1px solid #e2e8f0",
              boxShadow: "0 24px 70px rgba(15,23,42,0.35)",
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
                background: "#f8fafc",
              }}
            >
              <div>
                <div style={{ color: "#0f172a", fontWeight: 700, fontSize: "1.05rem" }}>Invite drivers</div>
                <div style={{ color: "#475569", marginTop: "2px" }}>Invite drivers and manage their access for this location.</div>
              </div>
              <button
                type="button"
                onClick={closeInviteModal}
                aria-label="Close invite modal"
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
                ×
              </button>
            </div>
            <div style={{ padding: "16px 16px 18px", overflow: "auto" }}>
              <InviteList locationId={locationId} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
