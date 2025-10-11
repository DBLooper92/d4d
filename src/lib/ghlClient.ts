// src/lib/ghlClient.ts
// Server-side helper for calling HighLevel v2 (LeadConnectorHQ) APIs.

export const GHL_BASE = "https://services.leadconnectorhq.com";

export type GhlUser = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  role?: string | null;
};

const API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";

export async function ghlFetch<T>(
  path: string,
  opts: { accessToken: string; query?: Record<string, string | number | boolean | undefined> }
): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${GHL_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v !== undefined && v !== null && `${v}`.length) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      Accept: "application/json",
      Version: API_VERSION,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GHL request failed ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}
