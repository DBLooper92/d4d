// src/app/api/invites/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";
import { createHmac } from "crypto";

const GHL_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";

/**
 * Preferred config (optional):
 *   NEXT_PUBLIC_DRIVER_SIGNUP_URL=https://app.example.com/join/driver
 *   or
 *   NEXT_PUBLIC_SITE_URL=https://app.example.com   // we’ll append /join/driver
 *
 * If neither is set, we’ll derive origin from the request and use `${origin}/join/driver`.
 */
const DRIVER_SIGNUP_URL = process.env.NEXT_PUBLIC_DRIVER_SIGNUP_URL || "";
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "";
const SIGNING_SECRET = process.env.INVITES_SIGNING_SECRET || ""; // optional signing

export const runtime = "nodejs";

type InviteRequest = {
  locationId: string;
  email: string;
  ghlUserId: string; // GHL user ID for the invitee
  firstName?: string | null;
  lastName?: string | null;
  subject?: string | null;
  html?: string | null; // optional override; if missing we generate the email HTML
};

type UpsertJsonShapeA = { contact?: { id?: string } };
type UpsertJsonShapeB = { id?: string };
type UpsertJsonShapeC = { _id?: string };
type UpsertResponse = UpsertJsonShapeA | UpsertJsonShapeB | UpsertJsonShapeC;

type SendMessageResponse = {
  id?: string;
  message?: unknown;
} & Record<string, unknown>;

function bad(status: number, message: string) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return await res.text();
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function extractContactId(payload: unknown): string | null {
  if (!isObject(payload)) return null;
  const contactVal = payload["contact"];
  if (isObject(contactVal) && typeof contactVal["id"] === "string") return contactVal["id"] as string;
  if (typeof payload["id"] === "string") return payload["id"] as string;
  if (typeof payload["_id"] === "string") return payload["_id"] as string;
  return null;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default:  return c;
    }
  });
}

function getOriginFromRequest(req: NextRequest): string {
  // Prefer proxy headers (Firebase/App Hosting sets x-forwarded-*), fallback to req.nextUrl
  const xfProto = req.headers.get("x-forwarded-proto");
  const xfHost = req.headers.get("x-forwarded-host");
  if (xfProto && xfHost) return `${xfProto}://${xfHost}`;
  return req.nextUrl.origin;
}

function resolveSignupBaseUrl(req: NextRequest): string {
  if (DRIVER_SIGNUP_URL) return DRIVER_SIGNUP_URL.replace(/\/+$/, "");
  if (SITE_URL) return `${SITE_URL.replace(/\/+$/, "")}/join/driver`;
  // derive from request origin
  const origin = getOriginFromRequest(req);
  return `${origin.replace(/\/+$/, "")}/join/driver`;
}

function buildInviteUrl(req: NextRequest, params: {
  locationId: string;
  email: string;
  ghlUserId: string;
  firstName?: string | null;
}) {
  const base = resolveSignupBaseUrl(req);
  const url = new URL(base);
  const qp = url.searchParams;

  qp.set("l", params.locationId);                // locationId
  qp.set("u", params.ghlUserId);                 // GHL user id
  qp.set("e", params.email.toLowerCase());       // email
  if (params.firstName) qp.set("fn", params.firstName);

  if (SIGNING_SECRET) {
    const canonical = `l=${params.locationId}&u=${params.ghlUserId}&e=${params.email.toLowerCase()}${
      params.firstName ? `&fn=${params.firstName}` : ""
    }`;
    const sig = createHmac("sha256", SIGNING_SECRET).update(canonical).digest("hex");
    qp.set("s", sig);
  }

  return url.toString();
}

function defaultEmailHtml(firstName: string | undefined, inviteUrl: string): string {
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : "Hi,";
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#111">
    <p>${greeting}</p>
    <p>You’ve been invited to join your team’s <strong>Driving for Dollars</strong> app.</p>
    <p style="margin:24px 0">
      <a href="${inviteUrl}"
         style="display:inline-block;padding:12px 18px;border-radius:10px;text-decoration:none;background:#111;color:#fff">
        Join
      </a>
    </p>
    <p>If you weren’t expecting this, you can ignore this email.</p>
  </div>
  `.trim();
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as InviteRequest;

    const locationId = (body.locationId || "").trim();
    const email = (body.email || "").trim().toLowerCase();
    const ghlUserId = (body.ghlUserId || "").trim();

    if (!locationId) return bad(400, "locationId is required");
    if (!email) return bad(400, "email is required");
    if (!ghlUserId) return bad(400, "ghlUserId is required");

    // Build invite URL (used in email + returned for sandbox copying)
    const inviteUrl = buildInviteUrl(req, {
      locationId,
      email,
      ghlUserId,
      firstName: body.firstName ?? undefined,
    });

    const subject = (body.subject || "You're invited to Driving for Dollars").trim();
    const html = (body.html && body.html.trim().length > 0)
      ? body.html
      : defaultEmailHtml(body.firstName ?? undefined, inviteUrl);

    const accessToken = await getValidAccessTokenForLocation(locationId);

    // 1) Upsert the contact
    const upsertRes = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        Version: API_VERSION,
      },
      cache: "no-store",
      body: JSON.stringify({
        locationId,
        email,
        firstName: body.firstName ?? undefined,
        lastName: body.lastName ?? undefined,
        tags: ["D4D Invite"],
      }),
    });

    if (!upsertRes.ok) {
      const err = await safeJson(upsertRes);
      return NextResponse.json(
        { step: "upsert", error: err },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const upsertJson = (await upsertRes.json()) as unknown as UpsertResponse;
    const contactId = extractContactId(upsertJson);
    if (!contactId) {
      return NextResponse.json(
        { step: "upsert", error: "No contactId in upsert response" },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    // 2) Send the email (uses location default sender; we omit emailFrom)
    const sendRes = await fetch(`${GHL_BASE}/conversations/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        Version: API_VERSION,
      },
      cache: "no-store",
      body: JSON.stringify({
        type: "Email",
        contactId,
        subject,
        html,
      }),
    });

    // For sandbox: still return the inviteUrl even if the send fails
    if (!sendRes.ok) {
      const err = await safeJson(sendRes);
      return NextResponse.json(
        { step: "send", error: err, contactId, inviteUrl },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const messageJson = (await sendRes.json()) as unknown as SendMessageResponse;

    return NextResponse.json(
      { ok: true, contactId, sendResult: messageJson, inviteUrl },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || String(e) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
