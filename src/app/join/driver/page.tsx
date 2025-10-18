// src/app/join/driver/page.tsx
import Link from "next/link";

type Search = {
  l?: string; // locationId
  u?: string; // ghl user id
  e?: string; // email
  fn?: string; // firstName
  s?: string; // signature (optional)
};

export default async function Page({
  // Next.js 15: searchParams is a Promise on server components
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const qp: Search = {
    l: str(sp.l),
    u: str(sp.u),
    e: str(sp.e),
    fn: str(sp.fn),
    s: str(sp.s),
  };

  return (
    <main className="max-w-lg mx-auto p-6">
      <h1 className="text-2xl font-semibold">Join Driving for Dollars</h1>
      <p className="text-gray-600 mt-2">
        {qp.fn ? `Hi ${qp.fn},` : "Hi,"} complete your account to join your team.
      </p>

      <form
        className="mt-6 space-y-4"
        action="#"
        onSubmit={(e) => {
          e.preventDefault();
          alert("Stub signup — wire this form to your registration API.");
        }}
      >
        {/* Visible fields you might want to collect */}
        <div>
          <label className="block text-sm font-medium">First name</label>
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            name="firstName"
            defaultValue={qp.fn || ""}
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium">Email</label>
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            type="email"
            name="email"
            defaultValue={qp.e || ""}
            required
          />
        </div>

        {/* Hidden fields captured from the invite link */}
        <input type="hidden" name="locationId" value={qp.l || ""} />
        <input type="hidden" name="ghlUserId" value={qp.u || ""} />
        <input type="hidden" name="sig" value={qp.s || ""} />

        <button type="submit" className="btn primary">
          Create account
        </button>
      </form>

      <div className="mt-6 text-xs text-gray-500">
        <p>Debug (query params received):</p>
        <ul className="list-disc pl-5">
          <li>
            locationId: <code>{qp.l || "(missing)"}</code>
          </li>
          <li>
            ghlUserId: <code>{qp.u || "(missing)"}</code>
          </li>
          <li>
            email: <code>{qp.e || "(missing)"}</code>
          </li>
          <li>
            firstName: <code>{qp.fn || "(missing)"}</code>
          </li>
          <li>
            signature: <code>{qp.s || "(none)"}</code>
          </li>
        </ul>
        <p className="mt-2">
          <Link href="/">← Back to home</Link>
        </p>
      </div>
    </main>
  );
}

function str(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}
