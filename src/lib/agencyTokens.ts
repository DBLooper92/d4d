// File: src/lib/agencyTokens.ts
// Utility to obtain an Agency-scoped ACCESS TOKEN, trying multiple sources.
// 1) agencies/{agencyId}.refreshToken
// 2) Any locations where agencyId == X (scan in pages) and use the first working refreshToken

import { db } from "@/lib/firebaseAdmin";
import { exchangeRefreshToken } from "@/lib/ghlTokens";

export async function getAgencyAccessToken(agencyId: string): Promise<string | null> {
  if (!agencyId || !agencyId.trim()) return null;

  // Try agency doc refresh token first
  const agSnap = await db().collection("agencies").doc(agencyId).get();
  const ag = agSnap.exists ? (agSnap.data() || {}) : {};
  const rtRaw = (ag as Record<string, unknown>).refreshToken;
  const agencyRefresh = typeof rtRaw === "string" ? rtRaw.trim() : "";

  const tryExchange = async (rt: string) => {
    try {
      const tok = await exchangeRefreshToken(rt);
      return tok.access_token || null;
    } catch {
      return null;
    }
  };

  if (agencyRefresh) {
    const acc = await tryExchange(agencyRefresh);
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

      const acc = await tryExchange(rt);
      if (acc) return acc;
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }

  return null;
}
