// src/app/(d4d)/app/invites/page.tsx
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

export default async function InviteDriversPage({ searchParams }: Props) {
  const sp = ((await searchParams) ?? {}) as SearchParamRecord;
  const locationId =
    pick(sp, "location_id") || pick(sp, "locationId") || pick(sp, "location");
  const qs = locationId ? `?location_id=${encodeURIComponent(locationId)}` : "";

  return (
    <main className="p-6 max-w-3xl mx-auto">
      <header className="hero card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 className="text-2xl font-semibold">Invite Drivers</h1>
          {locationId ? (
            <p className="text-gray-600 mt-1">
              Location: <span className="badge">{locationId}</span>
            </p>
          ) : (
            <p className="text-red-600 mt-1">
              No <code>location_id</code> in URL — open from a sub-account sidebar.
            </p>
          )}
        </div>
        <a className="btn" href={`/app${qs}`}>Dashboard</a>
      </header>

      <section className="mt-4 card">
        <p className="text-gray-700">
          (Coming soon) Send invites to drivers for this location.
        </p>
      </section>
    </main>
  );
}
