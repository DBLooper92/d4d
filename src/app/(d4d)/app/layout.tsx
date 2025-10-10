// File: src/app/(d4d)/app/layout.tsx
//
// This file has been moved into the `(d4d)` route group.  Placing the
// `app` route under a route group allows you to keep all of the new
// Driving for Dollars features scoped to a single directory without
// affecting any of the existing OAuth and permission logic.  The
// `(d4d)` directory name will not be reflected in the public URL,
// but it provides a clean place to build additional routes like
// employee invitations, map pages, and address submission while
// keeping them isolated from the rest of the application.

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return children;
}