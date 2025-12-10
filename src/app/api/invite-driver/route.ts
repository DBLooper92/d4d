// src/app/api/invite-driver/route.ts
/*
 * Invite a driver:
 *  - Upsert contact (adds "d4d invite pending" tag).
 *  - Generate the /invite/join link.
 *  - Send an Email via Conversations API (requires contactId + status).
 *  - Return { joinUrl, contactId } even if email send fails.
 *
 * Uses your existing token logic; no changes there.
 */

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "@/lib/firebaseAdmin";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";

export const runtime = "nodejs";

// API versions per GHL docs
const CONTACTS_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const CONVERSATIONS_API_VERSION = "2021-04-15";

type InvitePayload = {
  locationId: string;
  email: string;
  name?: string | null;
  ghlUserId: string;
};

async function fetchJson<T = unknown>(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  const r = await fetch(url, init);
  const text = await r.text().catch(() => "");
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    data = null;
  }
  return { ok: r.ok, status: r.status, data, text };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<InvitePayload>;
    const locationId = (body.locationId || "").trim();
    const email = (body.email || "").trim();
    const ghlUserId = (body.ghlUserId || "").trim();
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!locationId) return NextResponse.json({ error: "Missing locationId" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    if (!email) return NextResponse.json({ error: "Missing email" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    if (!ghlUserId) return NextResponse.json({ error: "Missing ghlUserId" }, { status: 400, headers: { "Cache-Control": "no-store" } });

    const accessToken = await getValidAccessTokenForLocation(locationId);

    // Derive first/last from name (optional)
    let firstName: string | undefined;
    let lastName: string | undefined;
    if (name) {
      const parts = name.split(/\s+/).filter(Boolean);
      if (parts.length === 1) firstName = parts[0];
      if (parts.length > 1) {
        firstName = parts[0];
        lastName = parts.slice(1).join(" ");
      }
    }

    // 1) Upsert contact with tag
    const upsertPayload: Record<string, unknown> = {
      locationId,
      email,
      tags: ["d4d invite pending"],
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
    };
    const upsert = await fetchJson<{ id?: string; contactId?: string }>(
      "https://services.leadconnectorhq.com/contacts/upsert",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: CONTACTS_API_VERSION,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(upsertPayload),
      },
    );

    let contactId: string | null =
      (upsert.data?.id as string | undefined) ||
      (upsert.data?.contactId as string | undefined) ||
      null;

    // If upsert did not return an id, try a lightweight search by email
    if (!contactId) {
      const searchUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${encodeURIComponent(
        locationId,
      )}&query=${encodeURIComponent(email)}&limit=1`;
      const search = await fetchJson<{ contacts?: Array<{ id: string }> }>(searchUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: CONTACTS_API_VERSION,
          Accept: "application/json",
        },
      });
      if (search.ok && Array.isArray(search.data?.contacts) && search.data!.contacts.length > 0) {
        contactId = search.data!.contacts[0].id;
      } else {
        console.error("Could not obtain contactId after upsert; email send will be skipped.", search.status, search.text);
      }
    }

    // 2) Build the join URL
    const baseApp = process.env.NEXT_PUBLIC_APP_BASE_URL?.replace(/\/$/, "") || "https://admin.driving4dollars.co";
    const url = new URL(`${baseApp}/invite/join`);
    url.searchParams.set("email", email);
    url.searchParams.set("location_id", locationId);
    url.searchParams.set("user_id", ghlUserId);
    const joinUrl = url.toString();

    // 3) Attempt email send (requires contactId + required fields)
    if (contactId) {
      const subject = "You've been invited to Driving for Dollars";
      const html =
        `<p>You've been invited to join your team's Driving for Dollars.</p>` +
        `<p><a href="${joinUrl}" target="_blank" rel="noopener noreferrer">Join</a></p>`;

      const messagePayload: Record<string, unknown> = {
        type: "Email",
        status: "delivered", // required by Conversations API
        contactId,
        subject,
        html,
        emailTo: email, // destination; omit emailFrom to use location default
      };

      const send = await fetchJson("https://services.leadconnectorhq.com/conversations/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: CONVERSATIONS_API_VERSION,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messagePayload),
      });

      if (!send.ok) {
        console.error("Invite email send failed", send.status, send.text);
      }
    }

    try {
      const inviteKey = `invites.${ghlUserId}`;
      await db()
        .collection("locations")
        .doc(locationId)
        .set(
          {
            [inviteKey]: {
              status: "invited",
              invitedAt: FieldValue.serverTimestamp(),
              lastSentAt: FieldValue.serverTimestamp(),
              invitedBy: null,
            },
          },
          { merge: true },
        );
    } catch {
      /* best-effort invite record */
    }

    return NextResponse.json({ joinUrl, contactId }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
