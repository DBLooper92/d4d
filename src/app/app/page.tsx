import AgencyLocations from "@/components/agency/AgencyLocations";
import AuthClient from "@/components/auth/AuthClient";

// This is the Next.js route segment option. Keep the exact export name "dynamic".
export const dynamic = "auto";

type SearchParamRecord = Record<string, string | string[] | undefined>;

type Props = {
  searchParams?: SearchParamRecord | Promise<SearchParamRecord>;
};

function pickParam(sp: SearchParamRecord, key: string): string {
  const raw = sp?.[key];
  if (Array.isArray(raw)) return (raw[0] || "").trim();
  return (raw || "").trim();
}

export default async function AppPage({ searchParams }: Props) {
  const resolved = (await searchParams) ?? {};

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
