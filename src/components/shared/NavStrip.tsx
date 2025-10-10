// src/components/shared/NavStrip.tsx
"use client";

import { useMemo } from "react";

export default function NavStrip() {
  const search = useMemo(() => {
    try {
      const u = new URL(window.location.href);
      // Preserve any qs like ?agencyId=... or ?location_id=...
      return u.search || "";
    } catch {
      return "";
    }
  }, []);

  const link = (path: string, label: string, primary = false) => (
    <a
      key={path}
      href={`${path}${search}`}
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
