const PUBLIC_PREFIX = "NEXT_PUBLIC_";

export function GET() {
  const entries = Object.entries(process.env)
    .filter(([k]) => k.startsWith(PUBLIC_PREFIX))
    .map(([k, v]) => [k, String(v ?? "")]);

  return new Response(JSON.stringify(Object.fromEntries(entries), null, 2), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
