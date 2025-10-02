import pkg from "@/../package.json";

export default function Page() {
  return (
    <main style={{ padding: 24 }}>
      <h1>D4D Ready</h1>
      <p>Next.js App Router on Firebase App Hosting.</p>
      <p>
        Version: <code>{pkg.version}</code>
      </p>
      <p>
        <a href="/api/health">/api/health</a> | <a href="/api/public-env">/api/public-env</a> | <a href="/api/version">/api/version</a>
      </p>
    </main>
  );
}
