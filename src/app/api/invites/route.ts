// src/app/api/invites/route.ts
import { NextRequest, NextResponse } from "next/server";

/**
 * Request payload the UI should send to this endpoint.
 * Keep this minimal and explicit to avoid `any`.
 */
export type InviteRequest = {
  locationId: string;
  recipients: Array<{
    email: string;
    firstName?: string;
    lastName?: string;
  }>;
  tags?: string[];
  source?: string; // e.g., "Driving for Dollars"
  message?: string; // optional invite message (not sent to GHL)
};

/** Minimal shape of the Upsert Contact response we care about */
type UpsertContactResponse = {
  contact: {
    id: string;
    locationId: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
    tags?: string[] | null;
    dateAdded?: string | null;
    dateUpdated?: string | null;
  };
  new: boolean;
};

/** Error shape returned by GHL APIs */
type GhlErrorResponse = {
  statusCode?: number;
  message?: string | string[];
  error?: string;
};

/** Narrow unknown into InviteRequest at runtime */
function isInviteRequest(value: unknown): value is InviteRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.locationId !== "string" || !v.locationId.trim()) return false;

  if (!Array.isArray(v.recipients)) return false;
  for (const r of v.recipients) {
    if (typeof r !== "object" || r === null) return false;
    const rr = r as Record<string, unknown>;
    if (typeof rr.email !== "string" || !rr.email.includes("@")) return false;
    if (rr.firstName !== undefined && typeof rr.firstName !== "string") return false;
    if (rr.lastName !== undefined && typeof rr.lastName !== "string") return false;
  }

  if (v.tags !== undefined && (!Array.isArray(v.tags) || v.tags.some(t => typeof t !== "string"))) {
    return false;
  }
  if (v.source !== undefined && typeof v.source !== "string") return false;
  if (v.message !== undefined && typeof v.message !== "string") return false;

  return true;
}

const GHL_CONTACTS_UPSERT_URL = "https://services.leadconnectorhq.com/contacts/upsert";
const GHL_API_VERSION = "2021-07-28";

/**
 * Reads a server-only token for GHL.
 * Prefer OAuth Location token at runtime. As a sensible default for development,
 * we also allow a Private Integration token via env.
 *
 * Set one of:
 *  - GHL_OAUTH_LOCATION_TOKEN   (recommended at runtime)
 *  - GHL_PRIVATE_INTEGRATION_TOKEN (dev/testing)
 */
function getGhlBearerToken(): string | null {
  return (
    process.env.GHL_OAUTH_LOCATION_TOKEN ||
    process.env.GHL_PRIVATE_INTEGRATION_TOKEN ||
    null
  );
}

export async function POST(req: NextRequest) {
  // Parse and validate the request without using `any`.
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  if (!isInviteRequest(payload)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Invalid payload. Expect { locationId, recipients:[{email,firstName?,lastName?}], tags?, source?, message? }",
      },
      { status: 400 },
    );
  }

  const token = getGhlBearerToken();
  if (!token) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Missing GHL auth token. Set GHL_OAUTH_LOCATION_TOKEN or GHL_PRIVATE_INTEGRATION_TOKEN on the server.",
      },
      { status: 500 },
    );
  }

  const { locationId, recipients, tags = [], source = "D4D Invite" } = payload;

  // Upsert each recipient into GHL contacts
  const results: Array<
    | { email: string; status: "created" | "updated"; contactId: string }
    | { email: string; status: "error"; error: string; statusCode?: number }
  > = [];

  for (const r of recipients) {
    const body = {
      locationId,
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      source,
      // NOTE: Upsert replaces tags with provided list; adjust if you need additive behavior.
      tags: tags.length > 0 ? tags : undefined,
    };

    try {
      const res = await fetch(GHL_CONTACTS_UPSERT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Version: GHL_API_VERSION,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // Try to decode GHL error payload in a typed way (unknown → narrowed)
        let errJson: unknown;
        try {
          errJson = await res.json();
        } catch {
          errJson = { message: "Unknown error from GHL." };
        }
        const err = errJson as GhlErrorResponse;
        results.push({
          email: r.email,
          status: "error",
          error:
            (Array.isArray(err.message) ? err.message.join("; ") : err.message) ||
            err.error ||
            `HTTP ${res.status}`,
          statusCode: err.statusCode ?? res.status,
        });
        continue;
      }

      const data: unknown = await res.json();
      // Narrow the success response
      const upsert = data as UpsertContactResponse;

      const contactId = upsert?.contact?.id ?? "";
      const status: "created" | "updated" = upsert?.new ? "created" : "updated";
      results.push({ email: r.email, status, contactId });
    } catch (e: unknown) {
      // Never use `any` in catch; treat as unknown, then format safely.
      const message =
        e instanceof Error ? e.message : "Unexpected error while calling GHL.";
      results.push({ email: r.email, status: "error", error: message });
    }
  }

  return NextResponse.json({ ok: true, locationId, results });
}
