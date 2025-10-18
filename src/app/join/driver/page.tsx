// src/app/join/driver/page.tsx
import Link from "next/link";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function getParam(
  params: SearchParams,
  key: string,
  fallback = ""
): string {
  const v = params[key];
  if (Array.isArray(v)) return v[0] ?? fallback;
  return v ?? fallback;
}

export default function Page({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const sp = searchParams ?? {};

  const firstName = getParam(sp, "firstName");
  const email = getParam(sp, "email");
  const ghlUserId = getParam(sp, "ghlUserId");
  const locationId = getParam(sp, "locationId");

  // This is just a simple confirmation UI — your real signup form can live here.
  // We render hidden fields so the POST target can capture IDs.
  const joinAction = "/api/join/driver"; // adjust to your handler when ready

  return (
    <main className="mx-auto max-w-xl p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Join Driving 4 Dollars</h1>

      <p className="text-sm text-gray-600">
        Hi {firstName || "there"}! Complete your account below.
      </p>

      <form
        method="POST"
        action={joinAction}
        className="space-y-4 border rounded-md p-4"
      >
        {/* Hidden identifiers we pass through */}
        <input type="hidden" name="ghlUserId" value={ghlUserId} />
        <input type="hidden" name="locationId" value={locationId} />

        {/* Prefill-first experience — you can expand this later */}
        <div className="space-y-1">
          <label className="block text-sm font-medium">First name</label>
          <input
            name="firstName"
            defaultValue={firstName}
            className="w-full rounded border px-3 py-2"
            required
          />
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium">Email</label>
          <input
            type="email"
            name="email"
            defaultValue={email}
            className="w-full rounded border px-3 py-2"
            required
          />
        </div>

        <button
          type="submit"
          className="inline-flex items-center rounded bg-black px-4 py-2 text-white"
        >
          Create my account
        </button>
      </form>

      <div className="text-xs text-gray-500">
        Trouble?{" "}
        <Link href="/" className="underline">
          Go home
        </Link>
      </div>
    </main>
  );
}
