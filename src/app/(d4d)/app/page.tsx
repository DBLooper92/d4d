// src/app/(d4d)/app/page.tsx
import RequireLocationAuth from "@/components/auth/RequireLocationAuth";
import SkiptraceToggle from "@/components/dashboard/SkiptraceToggle";
import DashboardInsights from "@/components/dashboard/DashboardInsights";

type PageParamRecord = Record<string, string | string[] | undefined>;
type SearchParamRecord = Record<string, string | string[] | undefined>;

export const dynamic = "auto";

type Props = {
  params?: Promise<PageParamRecord>;
  searchParams?: Promise<SearchParamRecord>;
};

function pick(sp: SearchParamRecord, k: string) {
  const v = sp?.[k];
  return Array.isArray(v) ? (v[0] || "").trim() : (v || "").trim();
}

export default async function AppPage({ searchParams }: Props) {
  const sp = ((await searchParams) ?? {}) as SearchParamRecord;
  const locationId =
    pick(sp, "location_id") || pick(sp, "locationId") || pick(sp, "location");

  if (!locationId) {
    // Agency-level landing (install redirect tab with no location_id)
    return (
      <main className="p-6 max-w-4xl mx-auto">
        <header className="hero card">
          <h1 className="text-2xl font-semibold">Driving for Dollars — Installed</h1>
          <p className="text-gray-700 mt-2">
            Thanks for installing. To use the app, open it from a sub-account’s sidebar.
          </p>
        </header>

        <section className="mt-4 card">
          <h2 className="text-lg font-semibold">How to launch for a location</h2>
          <ol className="text-gray-700 mt-2" style={{ paddingLeft: "1.25rem", listStyle: "decimal" }}>
            <li>Go to a sub-account in GoHighLevel.</li>
            <li>Click your custom menu link for “Driving for Dollars”.</li>
            <li>The app will open with the correct <code>location_id</code>.</li>
          </ol>
          <p className="text-sm text-gray-600 mt-3">
          </p>
        </section>
      </main>
    );
  }

  // Location-level Dashboard (auth-gated)
return (
  <RequireLocationAuth>
    <main className="p-6 max-w-4xl mx-auto">

        <header className="hero card" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1.5rem", flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: "0.4rem" }}>
            <div style={{ color: "#475569", fontSize: "0.95rem", fontWeight: 600 }}>Location</div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <div className="badge" style={{ fontWeight: 700, fontSize: "1rem" }}>{locationId}</div>
              <span style={{ color: "#64748b" }}>Dashboard overview</span>
            </div>
            <p style={{ margin: 0, color: "#475569", fontSize: "0.95rem", maxWidth: "42ch" }}>
              Track driver output, map coverage, and GHL contacts in real time.
            </p>
          </div>
          <div style={{ display: "grid", gap: "0.5rem", justifyItems: "end", textAlign: "right", minWidth: "220px" }}>
            <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "#0f172a" }}>Skiptrace</div>
            <SkiptraceToggle locationId={locationId} />
            <p style={{ margin: 0, color: "#475569", fontSize: "0.9rem", maxWidth: "28ch" }}>
              Auto-skiptrace new properties. $0.15 per property while enabled.
            </p>
          </div>
        </header>

        <DashboardInsights locationId={locationId} />
      </main>
    </RequireLocationAuth>
  );
}
