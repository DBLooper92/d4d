export type GhlJson = Record<string, unknown>;

const BASE = "https://services.leadconnectorhq.com";

export async function ghlFetch<T = GhlJson>(
  path: string,
  opts: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    token?: string;         // Bearer
    version?: string;       // e.g. "2021-07-28"
    headers?: Record<string, string>;
    body?: unknown;         // auto JSON or x-www-form-urlencoded by caller
    rawBody?: BodyInit;     // if you need to set your own body and headers
  } = {}
): Promise<T> {
  const { method = "GET", token, version, headers = {}, body, rawBody } = opts;

  const h: Record<string, string> = {
    Accept: "application/json",
    ...headers,
  };
  if (version) h["Version"] = version;
  if (token) h["Authorization"] = `Bearer ${token}`;

  let finalBody: BodyInit | undefined = undefined;
  if (rawBody !== undefined) {
    finalBody = rawBody;
  } else if (body !== undefined) {
    h["Content-Type"] = h["Content-Type"] ?? "application/json";
    finalBody = h["Content-Type"] === "application/json"
      ? JSON.stringify(body)
      : (body as BodyInit);
  }

  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: finalBody, cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GHL ${method} ${path} failed ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}
