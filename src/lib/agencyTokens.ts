// src/lib/agencyTokens.ts
// Obtain an Agency-scoped ACCESS TOKEN, trying multiple sources.
// Persists rotated refresh tokens when present.

import { db } from "@/lib/firebaseAdmin";
import { exchangeRefreshToken } from "@/lib/ghlTokens";

type Source =
  | { kind: "agency"; path: string }
  | { kind: "location"; path: string };

export async function getAgencyAccessToken(agencyId: string): Promise<string | null> {
  if (!agencyId || !agencyId.trim()) return null;

  // Try agency doc refresh token first
  const agRef = db().collection("agencies").doc(agencyId);
  const agSnap = await agRef.get();
  const ag = agSnap.exists ? (agSnap.data() || {}) : {};
  const rtRaw = (ag as Record<string, unknown>).refreshToken;
  const agencyRefresh = typeof rtRaw === "string" ? rtRaw.trim() : "";

  const tryExchange = async (rt: string, source: Source) => {
    try {
      const tok = await exchangeRefreshToken(rt);
      // Persist rotated refresh_token if returned
      if (tok.refresh_token) {
        if (source.kind === "agency") {
          await agRef.set({ refreshToken: tok.refresh_token }, { merge: true });
        } else {
          await db().doc(source.path).set({ refreshToken: tok.refresh_token }, { merge: true });
        }
      }
      return tok.access_token || null;
    } catch {
      return null;
    }
  };

  if (agencyRefresh) {
    const acc = await tryExchange(agencyRefresh, { kind: "agency", path: agRef.path });
    if (acc) return acc;
  }

  // Fallback: scan locations under this agency to find any valid refresh token
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  const PAGE = 200;

  while (true) {
    let q = db().collection("locations").where("agencyId", "==", agencyId).limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    for (const d of snap.docs) {
      const data = (d.data() || {}) as Record<string, unknown>;
      const rtVal = data.refreshToken;
      const rt = typeof rtVal === "string" ? rtVal.trim() : "";
      if (!rt) continue;

      const acc = await tryExchange(rt, { kind: "location", path: d.ref.path });
      if (acc) return acc;
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }

  return null;
}
