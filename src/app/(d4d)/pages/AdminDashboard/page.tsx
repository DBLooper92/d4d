// src/app/(d4d)/pages/AdminDashboard/page.tsx
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

export default async function AdminDashboard({ searchParams }: Props) {
  const sp = ((await searchParams) ?? {}) as SearchParamRecord;
  const locationId = pick(sp, "location_id") || pick(sp, "locationId") || pick(sp, "location");
  const agencyId = pick(sp, "agencyId") || pick(sp, "companyId");

  return (
    <main className="p-6 max-w-6xl mx-auto">
      <header className="hero card">
        <h1 className="text-2xl font-semibold">Admin Dashboard</h1>
        <p className="text-gray-600 mt-1">
          {agencyId && (
            <>
              Agency: <span className="badge" style={{ background: "var(--blue-50)", borderColor: "var(--blue-100)" }}>{agencyId}</span>
            </>
          )}
          {agencyId && locationId && <span> {" - "} </span>}
          {locationId && (
            <>
              Location: <span className="badge">{locationId}</span>
            </>
          )}
        </p>
      </header>

      <section className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="card">
          <h2 className="text-lg font-semibold">Quick Actions</h2>
          <div className="mt-3 flex gap-2 flex-wrap">
            <a className="btn" href="/app">Open App Home</a>
            <a className="btn" href="/api/installed?_debug=1">Check Install State</a>
            <a className="btn primary" href="#">Invite Drivers (soon)</a>
          </div>
        </div>
        <div className="card">
          <h2 className="text-lg font-semibold">Roadmap</h2>
          <ul className="text-sm text-gray-700 mt-2" style={{ listStyle: "disc", paddingLeft: "1.25rem" }}>
            <li>Drive mode with path polyline</li>
            <li>Property capture (photos/tags/notes)</li>
            <li>Offline queue + GHL sync</li>
          </ul>
        </div>
        <div className="card">
          <h2 className="text-lg font-semibold">Support</h2>
          <p className="text-gray-700 mt-2">Need help? Reply to your onboarding email and we&apos;ll jump in.</p>
        </div>
      </section>
    </main>
  );
}
