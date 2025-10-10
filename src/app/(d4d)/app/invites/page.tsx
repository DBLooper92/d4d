// File: src/app/(d4d)/app/invites/page.tsx
//
// This page will host the "Invite Employees" functionality.  Keeping
// it under the `(d4d)` route group means future implementation
// details, such as forms, API calls, and state management, will be
// encapsulated away from the existing OAuth and permission logic.  You
// can replace the placeholder content below with the actual
// invitation UI when you're ready to implement it.

export const dynamic = "auto";

export default function InvitesPage() {
  return (
    <main className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-semibold">Invite Employees</h1>
      <p className="text-gray-700 mt-2">
        This page is a placeholder for sending invitation emails or links to
        employees.  Add your form and logic here to invite users to join a
        specific location or role within your agency.
      </p>
    </main>
  );
}