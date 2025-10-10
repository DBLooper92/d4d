// src/app/(d4d)/app/page.tsx
type PageParamRecord = Record<string, string | string[] | undefined>;
type SearchParamRecord = Record<string, string | string[] | undefined>;

import AuthClient from "@/components/auth/AuthClient";

export const dynamic = "auto";

type Props = {
  params?: Promise<PageParamRecord>;
  searchParams?: Promise<SearchParamRecord>;
};

function pick(sp: SearchParamRecord, key: string): string {
  const raw = sp?.[key];
  if (Array.isArray(raw)) return (raw[0] || "").trim();
  return (raw || "").trim();
}

export default async function AppPage({ searchParams }: Props) {
  const resolved = ((await searchParams) ?? {}) as SearchParamRecord;

  const locationId =
    pick(resolved, "location_id") ||
    pick(resolved, "locationId") ||
    pick(resolved, "location");

  if (!locationId) {
    // Hard fail (by design): this app must be opened from a sub-account CML
    // configured like:  https://app.driving4dollars.co/app?location_id={{location.id}}
    return (
      <main style={{ padding: 24 }}>
        <h1>Sub-account Only</h1>
        <p style={{ marginTop: 8 }}>
          No <code>location_id</code> detected. Open this app from your sub-account’s custom menu link
          configured with <code>?location_id=&#123;&#123;location.id&#125;&#125;</code>.
        </p>
      </main>
    );
  }

  // We have a location_id → go straight to auth/registration flow.
  return <AuthClient />;
}
