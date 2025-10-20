// src/app/invite/join/page.tsx
import { Suspense } from "react";
import InviteJoinClient from "./InviteJoinClient";

export default function Page() {
  return (
    <main className="p-6 max-w-md mx-auto">
      <h1 className="text-2xl font-semibold mb-4">Join Driving for Dollars</h1>
      <Suspense fallback={<div className="text-sm text-gray-600">Loading…</div>}>
        <InviteJoinClient />
      </Suspense>
    </main>
  );
}
