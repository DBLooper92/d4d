import pkg from "@/../package.json";

export function GET() {
  return new Response(JSON.stringify({ name: pkg.name, version: pkg.version }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
