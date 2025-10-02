"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Minimal SSO decode helper to pull agency/company id when opened inside GHL at the agency level.
 * We only need activeCompanyId here.
 */
type EncryptedPayloadObject = { iv: string; cipherText: string; tag: string };
type EncryptedAny = string | EncryptedPayloadObject;

type SsoContext = {
  activeCompanyId?: string | null;
};

type MarketplaceMessage =
  | { message: "REQUEST_USER_DATA_RESPONSE"; encryptedData: EncryptedAny }
  | { message: "REQUEST_USER_DATA_RESPONSE"; payload: EncryptedAny };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function getAgencyFromMarketplace(): Promise<string | null> {
  // Ask parent for the encrypted payload
  const encrypted = await new Promise<EncryptedAny | null>((resolve) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) resolve(null);
    }, 3000);

    try {
      window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*");

      const onMsg = (ev: MessageEvent<unknown>) => {
        const data = ev?.data as unknown;

        if (isObj(data) && data["message"] === "REQUEST_USER_DATA_RESPONSE") {
          const mm = data as MarketplaceMessage;

          const maybe =
            "encryptedData" in mm
              ? (mm.encryptedData as unknown)
              : "payload" in mm
              ? (mm.payload as unknown)
              : null;

          const okString = typeof maybe === "string" && !!maybe;
          const okObj =
            isObj(maybe) &&
            typeof (maybe as EncryptedPayloadObject).iv === "string" &&
            typeof (maybe as EncryptedPayloadObject).cipherText === "string" &&
            typeof (maybe as EncryptedPayloadObject).tag === "string";

          if (okString || okObj) {
            done = true;
            clearTimeout(timeout);
            window.removeEventListener("message", onMsg as EventListener);
            resolve(maybe as EncryptedAny);
            return;
          }
        }
      };

      window.addEventListener("message", onMsg as EventListener);
    } catch {
      clearTimeout(timeout);
      resolve(null);
    }
  });

  if (!encrypted) return null;

  try {
    const r = await fetch("/api/user-context/decode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encryptedData: encrypted }),
    });
    if (!r.ok) return null;
    const json = (await r.json()) as SsoContext;
    return json.activeCompanyId ?? null;
  } catch {
    return null;
  }
}

function pickAgencyFromUrl(u: URL) {
  const fromQS =
    u.searchParams.get("agency_id") ||
    u.searchParams.get("agencyId") ||
    u.searchParams.get("companyId") ||
    "";
  return (fromQS || "").trim();
}

type LocationRow = {
  locationId: string;
  name: string | null;
  isInstalled: boolean;
  updatedAt: unknown;
};

export default function AgencyLocations() {
  const [agencyId, setAgencyId] = useState<string | null>(null);
  const [items, setItems] = useState<LocationRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const agencyFromUrl = useMemo(() => {
    try {
      const u = new URL(window.location.href);
      return pickAgencyFromUrl(u);
    } catch {
      return "";
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);

      // 1) Prefer agency from URL if present
      let finalAgency = agencyFromUrl;

      // 2) Otherwise, try marketplace SSO (when opened at agency level)
      if (!finalAgency) {
        finalAgency = (await getAgencyFromMarketplace()) || "";
      }

      if (!finalAgency) {
        setErr(
          "We couldn't detect your Agency ID. Open this app from your Agency-level custom menu or pass ?agencyId=AGENCY_ID in the URL."
        );
        setLoading(false);
        return;
      }

      setAgencyId(finalAgency);

      try {
        const r = await fetch(`/api/agency/locations?agencyId=${encodeURIComponent(finalAgency)}`, {
          headers: { "Cache-Control": "no-store" },
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error || `Query failed (${r.status})`);
        }
        const data = (await r.json()) as { items: LocationRow[] };
        setItems(data.items || []);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [agencyFromUrl]);

  return (
    <main className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-3">All locations</h1>
      {agencyId && <p className="text-sm text-gray-600 mb-4">Agency: <code>{agencyId}</code></p>}

      {loading && <p className="text-gray-700">Loading locations…</p>}

      {!loading && err && (
        <p className="text-red-600">
          {err}
        </p>
      )}

      {!loading && !err && items && items.length === 0 && (
        <p className="text-gray-700">No locations found for this agency.</p>
      )}

      {!loading && !err && items && items.length > 0 && (
        <div className="mt-4 divide-y rounded-xl border">
          {items.map((loc) => (
            <div key={loc.locationId} className="p-3 flex items-center justify-between">
              <div>
                <div className="font-medium">
                  {loc.name || "(no name)"}{" "}
                  <span className="text-xs text-gray-500">[{loc.locationId}]</span>
                </div>
              </div>
              <div className="text-sm">
                {loc.isInstalled ? (
                  <span className="px-2 py-1 rounded-lg border">Installed</span>
                ) : (
                  <span className="px-2 py-1 rounded-lg border bg-gray-50">Not installed</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
