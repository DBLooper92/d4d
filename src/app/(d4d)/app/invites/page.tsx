// src/app/(d4d)/app/invites/page.tsx
import InviteList from "@/components/invites/InviteList";

// App Router page can receive searchParams
type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

export default function InvitesPage({ searchParams }: PageProps) {
  const locationId =
    (typeof searchParams.location_id === "string" && searchParams.location_id) ||
    (typeof searchParams.locationId === "string" && searchParams.locationId) ||
    "";

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Invite Drivers</h1>
      {/* Pass as prop (InviteList declares this now) */}
      <InviteList locationId={locationId} />
    </main>
  );
}
