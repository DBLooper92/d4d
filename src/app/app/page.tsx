// src/app/app/page.tsx
import AgencyLocations from "@/components/agency/AgencyLocations";
import NextDynamic from "next/dynamic";

// AuthClient uses Firebase client SDK; load on client only
const AuthClient = NextDynamic(() => import("@/components/auth/AuthClient"), { ssr: false });

// This is the Next.js route segment option. Keep the exact export name "dynamic".
export const dynamic = "auto";

type Props = {
  searchParams?: Record<string, string | string[] | undefined>;
};

function pickParam(sp: Props["searchParams"], key: string): string {
  const raw = sp?.[key];
  if (Array.isArray(raw)) return (raw[0] || "").trim();
  return (raw || "").trim();
}

export default async function AppPage(props: Props) {
  const locationId =
    pickParam(props.searchParams, "location_id") ||
    pickParam(props.searchParams, "locationId") ||
    pickParam(props.searchParams, "location");

  // If a location is present → sub-account flow (Auth screen: register/login)
  // Otherwise → agency flow (All locations list)
  if (locationId) {
    return <AuthClient />;
  }

  return <AgencyLocations />;
}
