// File: src/app/(d4d)/app/page.tsx
//
// This page has been relocated into the `(d4d)` route group to ensure
// that all new Driving for Dollars logic lives under a single
// directory.  Grouping under `(d4d)` does not change the public
// route (it remains `/app`), but it makes the project easier to
// maintain as additional features such as employee invitations and
// map functionality are added.

type PageParamRecord = Record<string, string | string[] | undefined>;
type SearchParamRecord = Record<string, string | string[] | undefined>;

import AgencyLocations from "@/components/agency/AgencyLocations";
import AuthClient from "@/components/auth/AuthClient";

// This is the Next.js route segment option. Keep the exact export name "dynamic".
export const dynamic = "auto";

type Props = {
  params?: Promise<PageParamRecord>;
  searchParams?: Promise<SearchParamRecord>;
};

function pickParam(sp: SearchParamRecord, key: string): string {
  const raw = sp?.[key];
  if (Array.isArray(raw)) return (raw[0] || "").trim();
  return (raw || "").trim();
}

export default async function AppPage({ searchParams }: Props) {
  const resolved = ((await searchParams) ?? {}) as SearchParamRecord;

  const locationId =
    pickParam(resolved, "location_id") ||
    pickParam(resolved, "locationId") ||
    pickParam(resolved, "location");

  // If a location is present -> sub-account flow (Auth screen: register/login)
  // Otherwise -> agency flow (All locations list)
  if (locationId) {
    return <AuthClient />;
  }

  return <AgencyLocations />;
}