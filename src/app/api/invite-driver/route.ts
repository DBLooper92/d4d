// src/app/api/invite-driver/route.ts
/*
 * API route to invite a driver to Driving for Dollars.
 *
 * This endpoint performs the following steps:
 *   1. Validates the payload contains a locationId, email and GHL user ID.
 *   2. Obtains a valid HighLevel access token for the given location using
 *      existing token logic (getValidAccessTokenForLocation).
 *   3. Upserts a contact in HighLevel via the `POST /contacts/upsert` endpoint.
 *      The request includes the locationId, email, derived first/last names
 *      (when available) and a "d4d invite pending" tag.  Upserting ensures
 *      that if a contact already exists it is updated rather than duplicated.
 *   4. Constructs a join URL that includes the invitee's email, the location
 *      and the GHL user ID.  This link points at the public join page
 *      (/invite/join) where the driver can complete registration.
 *   5. Attempts to send an email to the contact using the default email
 *      configured on the location.  The email body contains the join link.
 *      Failure to send an email does not abort the invite; the join link is
 *      still returned so the inviter can copy/paste it in testing environments.
 *
 * The response contains the generated joinUrl and contactId (if available).
 */

import { NextResponse } from "next/server";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";

export const runtime = "nodejs";

const API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";

type InvitePayload = {
  locationId: string;
  email: string;
  name?: string | null;
  ghlUserId: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<InvitePayload>;
    const locationId = (body.locationId || "").trim();
    const email = (body.email || "").trim();
    const ghlUserId = (body.ghlUserId || "").trim();
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!locationId)
      return NextResponse.json(
        { error: "Missing locationId" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    if (!email)
      return NextResponse.json(
        { error: "Missing email" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    if (!ghlUserId)
      return NextResponse.json(
        { error: "Missing ghlUserId" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );

    // Obtain a valid HighLevel access token for the location.  This call
    // internally handles refreshing tokens and persists the new access token
    // back to Firestore.  If the token cannot be obtained an exception is
    // thrown which will be caught below.
    const accessToken = await getValidAccessTokenForLocation(locationId);

    // Derive first and last names from the full name when available.  If the
    // name is undefined or blank the fields remain undefined.  Passing
    // undefined in the upsert payload omits the field entirely.
    let firstName: string | undefined;
    let lastName: string | undefined;
    if (name) {
      const parts = name.split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        firstName = parts[0];
      } else if (parts.length > 1) {
        firstName = parts.shift();
        lastName = parts.join(" ");
      }
    }

    // Upsert the contact.  Tags are additive so that the invitation can be
    // tracked separately from other tags on the contact.
    const upsertUrl = "https://services.leadconnectorhq.com/contacts/upsert";
    const upsertPayload: Record<string, unknown> = {
      locationId,
      email,
      tags: ["d4d invite pending"],
    };
    if (firstName) upsertPayload.firstName = firstName;
    if (lastName) upsertPayload.lastName = lastName;

    let contactId: string | null = null;
    try {
      const upsertRes = await fetch(upsertUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: API_VERSION,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(upsertPayload),
      });
      if (upsertRes.ok) {
        const data = (await upsertRes.json().catch(() => null)) as
          | { id?: string; contactId?: string }
          | null;
        // The contact ID may be returned in `id` or `contactId` depending on
        // the API version.  Normalise it if present.
        if (data) {
          contactId = (data.id as string) || (data.contactId as string) || null;
        }
      } else {
        // Capture the error text for logging but do not fail the invite flow.
        const txt = await upsertRes.text().catch(() => "");
        console.error(`Invite contact upsert failed ${upsertRes.status}: ${txt}`);
      }
    } catch (err) {
      console.error("Error calling upsert contact", err);
    }

    // Compose the join URL.  Use the externally configurable base URL when
    // available so that the link points at the correct domain.  This URL
    // includes the email, location and GHL user ID as query parameters so
    // the registration page can prefill and persist the context.
    const baseApp =
      process.env.NEXT_PUBLIC_APP_BASE_URL?.replace(/\/$/, "") ||
      "https://admin.driving4dollars.co";
    const url = new URL(`${baseApp}/invite/join`);
    url.searchParams.set("email", email);
    url.searchParams.set("location_id", locationId);
    url.searchParams.set("user_id", ghlUserId);
    const joinUrl = url.toString();

    // Prepare the outbound email body.  A simple HTML message instructs the
    // invitee to click the join link.  Use a clickable anchor rather than
    // relying on plain text URLs.
    const emailBody =
      `<p>You've been invited to join your team's Driving for Dollars.</p>` +
      `<p><a href="${joinUrl}" target="_blank">Join</a></p>`;

    // Attempt to send an email using the Conversations API.  The exact
    // parameters required by HighLevel vary by channel type; here we
    // deliberately include both the contactId (when available) and the
    // destination email.  If this call fails the invite will still be
    // considered successful.  Errors are logged for debugging in test
    // environments but not surfaced to the client.
    try {
      const sendUrl = "https://services.leadconnectorhq.com/conversations/messages";
      const messagePayload: Record<string, unknown> = {
        locationId,
        ...(contactId ? { contactId } : {}),
        toEmail: email,
        type: "Email",
        channel: "Email",
        subject: "You've been invited to Driving for Dollars",
        body: emailBody,
      };
      await fetch(sendUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: API_VERSION,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messagePayload),
      }).catch(() => {});
    } catch (err) {
      console.error("Invite email send failed", err);
    }

    return NextResponse.json(
      { joinUrl, contactId },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: msg },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}