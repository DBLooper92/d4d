// src/app/(d4d)/app/invites/page.tsx
import RequireLocationAuth from "@/components/auth/RequireLocationAuth";
import InviteList from "@/components/invites/InviteList";

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
    <RequireLocationAuth>
      <main className="p-6 max-w-5xl mx-auto">
        <header
          className="hero card"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "14px",
          }}
        >
          <div style={{ display: "grid", gap: "4px" }}>
            <p style={{ color: "#475569", fontWeight: 700, fontSize: "0.95rem", margin: 0 }}>
              Team settings
            </p>
            <h1 className="text-2xl font-semibold" style={{ margin: 0 }}>
              Invite drivers
            </h1>
            <p className="text-gray-600" style={{ marginTop: "2px" }}>
              Manage invitations and active status for this location without leaving the dashboard.
            </p>
          </div>
          <a className="btn" href={`/app${qs}`}>Back to dashboard</a>
        </header>

        <section className="mt-4">
          {locationId ? (
            <InviteList locationId={locationId} />
          ) : (
            <div className="card">
              Add a <code>location_id</code> query string or open this page from the sub-account dashboard.
            </div>
          )}
        </section>
      </main>
    </RequireLocationAuth>
  );
}
