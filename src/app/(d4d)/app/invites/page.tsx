// src/app/(d4d)/app/invites/page.tsx
import InviteList from "@/components/invites/InviteList";

// Next.js 15 App Router: searchParams is a Promise on server components.
type PageSearchParams = Record<string, string | string[] | undefined>;

export default async function InvitesPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const sp = await searchParams;

  const locationId =
    (typeof sp.location_id === "string" && sp.location_id) ||
    (typeof sp.locationId === "string" && sp.locationId) ||
    "";

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Invite Drivers</h1>
      {/* Pass to client component explicitly */}
      <InviteList locationId={locationId} />
    </main>
  );
}
