// src/app/api/invites/route.ts
import { NextResponse } from "next/server";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";
import { env } from "@/lib/env";

const GHL_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";

export const runtime = "nodejs";

type InviteRequest = {
  locationId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  subject?: string | null;
  html?: string | null;
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

  // shape A: { contact?: { id?: string } }
  const contactVal = payload["contact"];
  if (isObject(contactVal) && typeof contactVal["id"] === "string") {
    return contactVal["id"] as string;
  }

  // shape B: { id?: string }
  if (typeof payload["id"] === "string") {
    return payload["id"] as string;
  }

  // shape C: { _id?: string }
  if (typeof payload["_id"] === "string") {
    return payload["_id"] as string;
  }

  return null;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as InviteRequest;

    const locationId = (body.locationId || "").trim();
    const email = (body.email || "").trim().toLowerCase();

    if (!locationId) return bad(400, "locationId is required");
    if (!email) return bad(400, "email is required");

    const subject = (body.subject || "You're invited to D4D").trim();
    const html =
      (body.html ||
        `<p>Hi${body.firstName ? ` ${escapeHtml(body.firstName)}` : ""} —</p>
<p>You’ve been invited to try <strong>D4D</strong> for this location.</p>
<p>If you weren’t expecting this, you can ignore this email.</p>`).trim();

    // Acquire a valid location-scoped access token (auto-refresh & persist)
    const { token: accessToken } = await getValidAccessTokenForLocation({
      locationId,
      clientId: env.GHL_CLIENT_ID,
      clientSecret: env.GHL_CLIENT_SECRET,
    });

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

    // 2) Send the email via Conversations (uses location default sender)
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

    if (!sendRes.ok) {
      const err = await safeJson(sendRes);
      return NextResponse.json(
        { step: "send", error: err },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const messageJson = (await sendRes.json()) as unknown as SendMessageResponse;

    return NextResponse.json(
      {
        ok: true,
        contactId,
        sendResult: messageJson,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || String(e) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}
