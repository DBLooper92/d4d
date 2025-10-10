// src/lib/routes.ts
// ✅ remove the import of `Route`
export const ADMIN_DASHBOARD_ROUTE = "/pages/AdminDashboard" as const;

// -----------------------------------------------------------------------------
// Additional routes for the Driving for Dollars app.
// Keeping these here makes it easy to import strongly‑typed route strings
// throughout your application without sprinkling literal paths everywhere.
// -----------------------------------------------------------------------------

/**
 * Route to the employee invitation page.  Users with the appropriate
 * permissions can navigate to this path to send invites to their
 * colleagues.  This path lives under the `/app` section and inside the
 * `(d4d)` route group, but because route groups are ignored in the URL
 * structure it resolves to `/app/invites`.
 */
export const INVITES_ROUTE = "/app/invites" as const;

/**
 * Route to the map and address submission page.  This route will host
 * the interactive map where drivers can capture properties and notes.
 * It is also scoped under the `(d4d)` route group and resolves to
 * `/app/map` at runtime.
 */
export const MAP_ROUTE = "/app/map" as const;
