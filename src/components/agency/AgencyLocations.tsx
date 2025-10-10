// src/components/agency/AgencyLocations.tsx
"use client";

import { useEffect, useMemo, useState } from "react";

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

async function getAgencyFromServerFallback(): Promise<string | null> {
  try {
    const r = await fetch("/api/user-context/fallback-user", {
      method: "GET",
      headers: { "Cache-Control": "no-store" },
    });
    if (!r.ok) return null;
    const json = (await r.json()) as { activeCompanyId?: string | null; companyId?: string | null };
    return (json.activeCompanyId || json.companyId || null) ?? null;
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

      let finalAgency = agencyFromUrl;

      if (!finalAgency) {
        // 1) Try Marketplace postMessage (existing behavior)
        finalAgency = (await getAgencyFromMarketplace()) || "";
      }

      if (!finalAgency) {
        // 2) Server-side fallback when Marketplace message isn't available in iframe
        finalAgency = (await getAgencyFromServerFallback()) || "";
      }

      if (!finalAgency) {
        setErr(
          "We couldn't detect your Agency ID. Open this app from your Agency-level custom menu or pass ?agencyId=AGENCY_ID in the URL.",
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

  const stats = useMemo(() => {
    const total = items?.length ?? 0;
    const installed = items?.filter((loc) => loc.isInstalled).length ?? 0;
    const notInstalled = total - installed;
    return { total, installed, notInstalled };
  }, [items]);

  return (
    <main className="p-6 max-w-5xl mx-auto">
      <header className="hero card">
        <h1 className="text-2xl font-semibold">Agency Locations</h1>
        <p className="text-gray-600 mt-1">
          {agencyId ? (
            <>
              Agency: {" "}
              <span className="badge" style={{ background: "var(--blue-50)", borderColor: "var(--blue-100)" }}>
                {agencyId}
              </span>
            </>
          ) : (
            "Detecting agency..."
          )}
        </p>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="card">
            <div className="text-sm text-gray-600">Total</div>
            <div className="text-xl font-semibold">
              {loading ? <div className="skel" style={{ height: 24, width: 60 }} /> : stats.total}
            </div>
          </div>
          <div className="card">
            <div className="text-sm text-gray-600">Installed</div>
            <div className="text-xl font-semibold">
              {loading ? <div className="skel" style={{ height: 24, width: 60 }} /> : stats.installed}
            </div>
          </div>
          <div className="card">
            <div className="text-sm text-gray-600">Not installed</div>
            <div className="text-xl font-semibold">
              {loading ? <div className="skel" style={{ height: 24, width: 60 }} /> : stats.notInstalled}
            </div>
          </div>
        </div>
      </header>

      {loading && (
        <section className="mt-4 grid gap-2">
          {Array.from({ length: 5 }).map((_, idx) => (
            <div key={idx} className="card">
              <div className="skel" style={{ height: 20, width: "60%" }} />
              <div className="skel" style={{ height: 14, width: "30%", marginTop: 8 }} />
            </div>
          ))}
        </section>
      )}

      {!loading && err && (
        <section className="mt-4 card" style={{ borderColor: "#fecaca" }}>
          <p className="text-red-600">{err}</p>
        </section>
      )}

      {!loading && !err && items && items.length === 0 && (
        <section className="mt-4 card">
          <p className="text-gray-700">
            No locations found for this agency. Once sub-accounts are added, they will appear here with install status.
          </p>
        </section>
      )}

      {!loading && !err && items && items.length > 0 && (
        <section className="mt-4 grid gap-2">
          {items.map((loc) => (
            <div key={loc.locationId} className="card flex items-center justify-between">
              <div>
                <div className="font-medium">
                  {loc.name || "(no name)"}{" "}
                  <span className="text-xs text-gray-500">[{loc.locationId}]</span>
                </div>
                <div className="text-xs text-gray-500 mt-1">Updated: {String(loc.updatedAt ?? "-")}</div>
              </div>
              <div className="text-sm">
                {loc.isInstalled ? <span className="chip ok">Installed</span> : <span className="chip">Not installed</span>}
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}