// src/lib/ghlClient.ts
// Server-side helper for calling HighLevel v2 (LeadConnectorHQ) APIs

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

export type GhlRequestResult<T> = {
  ok: boolean;
  status: number;
  data: T | null;
  text: string;
};

export async function ghlRequest<T>(
  path: string,
  opts: {
    accessToken: string;
    method?: "GET" | "POST";
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  }
): Promise<GhlRequestResult<T>> {
  const url = new URL(path.startsWith("http") ? path : `${GHL_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v !== undefined && v !== null && `${v}`.length) url.searchParams.set(k, String(v));
  }
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.accessToken}`,
    Accept: "application/json",
    Version: API_VERSION,
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body,
    cache: "no-store",
  });

  const text = await res.text().catch(() => "");
  let data: T | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = null;
    }
  }
  return { ok: res.ok, status: res.status, data, text };
}
