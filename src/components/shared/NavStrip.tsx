// src/components/shared/NavStrip.tsx
"use client";

import { useMemo } from "react";

function pickLocationOnly(u: URL): string {
  const s = u.searchParams;
  return (
    s.get("location_id") ||
    s.get("locationId") ||
    s.get("location") ||
    ""
  )?.trim() || "";
}

export default function NavStrip() {
  const qs = useMemo(() => {
    try {
      const u = new URL(window.location.href);
      const loc = pickLocationOnly(u);
      return loc ? `?location_id=${encodeURIComponent(loc)}` : "";
    } catch {
      return "";
    }
  }, []);

  const link = (path: string, label: string, primary = false) => (
    <a
      key={path}
      href={`${path}${qs}`}
      className={`btn ${primary ? "primary" : ""}`}
      style={{ textDecoration: "none" }}
    >
      {label}
    </a>
  );

  return (
    <nav className="card" style={{ marginBottom: 12 }}>
      <div className="flex gap-2 flex-wrap">
        {link("/app", "Home")}
        {link("/pages/AdminDashboard", "Admin")}
        {link("/app/invites", "Invite Drivers")}
        {link("/app/map", "Map & Capture")}
      </div>
    </nav>
  );
}
