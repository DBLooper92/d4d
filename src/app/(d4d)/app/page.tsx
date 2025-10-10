// src/app/(d4d)/app/page.tsx
import RequireLocationAuth from "@/components/auth/RequireLocationAuth";

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
            Thanks for installing. To use the app, open it from a sub-account’s sidebar (the custom menu link passes
            <code> location_id </code> automatically).
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
            If you see this screen again, it means the link didn’t include <code>location_id</code>.
            Edit the CML to: <code>?location_id=&#123;&#123;location.id&#125;&#125;</code>
          </p>
        </section>
      </main>
    );
  }

  const qs = `?location_id=${encodeURIComponent(locationId)}`;

  // Location-level Dashboard (auth-gated)
return (
  <RequireLocationAuth>
    <main className="p-6 max-w-4xl mx-auto">

        <header className="hero card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 className="text-2xl font-semibold">Dashboard</h1>
            <p className="text-gray-600 mt-1">
              Location: <span className="badge">{locationId}</span>
            </p>
          </div>
          <a className="btn primary" href={`/app/invites${qs}`}>Invite Drivers</a>
        </header>

        <section className="mt-4 card">
          <p className="text-gray-700">Welcome! Your minimal location dashboard is ready.</p>
        </section>
      </main>
    </RequireLocationAuth>
  );
}
