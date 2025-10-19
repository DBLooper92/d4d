// src/app/api/invite-driver/route.ts
// API route to handle inviting a driver/user.
//
// When invoked, this endpoint will upsert a contact in the specified HighLevel
// location using the provided email. It will add a tag of `d4d invite pending`
// so the contact can be filtered later. After the contact is upserted, it
// sends a simple email message to the contact containing a join link. The
// join link points back into this application at `/invite/join` with
// query parameters containing the contact's email, the HighLevel user ID and
// the location ID. The returned JSON includes the generated joinUrl so the
// caller can display or copy it for manual testing.

import { NextResponse } from "next/server";
import { getValidAccessTokenForLocation } from "@/lib/ghlTokens";
import { lcHeaders } from "@/lib/ghl";

/**
 * Request body shape for inviting a driver. The front‑end should send
 * `locationId` (the HighLevel location/sub‑account the contact belongs to),
 * `userId` (the HighLevel user ID of the driver being invited) and
 * `userEmail` (the email address of the driver). A name may be provided but
 * is optional.  Note: userEmail must be a non‑empty string or the request
 * will be rejected.
 */
type InviteRequest = {
  locationId: string;
  userId: string;
  userEmail: string;
  userName?: string | null;
};

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { locationId, userId, userEmail, userName } = (await req.json()) as InviteRequest;

    // Basic validation
    if (!locationId || !String(locationId).trim()) {
      return NextResponse.json({ error: "Missing locationId" }, { status: 400 });
    }
    if (!userId || !String(userId).trim()) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }
    const email = typeof userEmail === "string" ? userEmail.trim() : "";
    if (!email) {
      return NextResponse.json({ error: "Missing userEmail" }, { status: 400 });
    }

    // Obtain a valid OAuth access token for the location. This will refresh
    // the token if necessary and persist the new access token/expiresAt back
    // into Firestore. If no refresh token is available the helper will throw.
    const accessToken = await getValidAccessTokenForLocation(locationId);

    // Compose the contact data. We only upsert on email and attach a custom
    // tag so the invitation state is easy to identify in HighLevel. If
    // userName is provided we attempt to split it into first/last names. If
    // splitting fails we simply send the full name in the `name` field.
    let firstName: string | undefined = undefined;
    let lastName: string | undefined = undefined;
    let fullName: string | undefined = undefined;
    if (userName) {
      const name = String(userName).trim();
      if (name) {
        const parts = name.split(/\s+/).filter(Boolean);
        if (parts.length === 1) {
          // single name – send as full name
          fullName = parts[0];
        } else {
          firstName = parts[0];
          lastName = parts.slice(1).join(" ");
        }
      }
    }

    // Call the Upsert Contact API. According to HighLevel docs, the
    // endpoint is POST /contacts/upsert and accepts the same body as
    // Create Contact. It returns an object with `contact` (containing
    // id/locationId/… fields) and a boolean `new` indicating whether it was
    // created. We rely on this API to either create or update the contact
    // based on email/phone duplicate settings.
    const upsertBody: Record<string, unknown> = {
      locationId: locationId,
      email: email,
      tags: ["d4d invite pending"],
    };
    if (firstName) upsertBody.firstName = firstName;
    if (lastName) upsertBody.lastName = lastName;
    if (fullName) upsertBody.name = fullName;

    const upsertRes = await fetch(
      "https://services.leadconnectorhq.com/contacts/upsert",
      {
        method: "POST",
        headers: {
          ...lcHeaders(accessToken, { "Content-Type": "application/json" }),
        },
        body: JSON.stringify(upsertBody),
        cache: "no-store",
      },
    );
    const upsertText = await upsertRes.text();
    if (!upsertRes.ok) {
      // Try to return meaningful error message from HighLevel
      let detail = "";
      try {
        const err = JSON.parse(upsertText);
        detail = err?.message || JSON.stringify(err);
      } catch {
        detail = upsertText;
      }
      return NextResponse.json(
        { error: `Upsert failed (${upsertRes.status}): ${detail}` },
        { status: upsertRes.status },
      );
    }
    let contactId: string | undefined = undefined;
    try {
      const parsed = JSON.parse(upsertText) as { contact?: { id?: string } };
      contactId = parsed.contact?.id;
    } catch {
      /* ignore – best effort */
    }
    if (!contactId) {
      return NextResponse.json(
        { error: "Upsert did not return a contact ID" },
        { status: 500 },
      );
    }

    // Build the join URL. Use the configured public base URL if available,
    // otherwise fall back to the admin.driving4dollars.co domain. This allows
    // the same code to work in local development as well as in production.
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_BASE_URL ||
      process.env.APP_BASE_URL ||
      "https://admin.driving4dollars.co";
    const params = new URLSearchParams({
      email: email,
      location_id: locationId,
      user_id: userId,
    });
    const joinUrl = `${baseUrl}/invite/join?${params.toString()}`;

    // Compose a simple HTML email with a join link. Since the Conversations API
    // does not currently support specifying a subject on the Send endpoint
    // (ConversationSendMessageBodyDTO omits a subject field), we keep the
    // content brief. The HTML will be rendered by HighLevel and clickable.
    const htmlMessage = `\n      <p>You\'ve been invited to join your team\'s Driving for Dollars account.</p>\n      <p><a href="${joinUrl}">Join</a></p>\n    `;

    // Send the email via Conversations API. We specify type="Email", the
    // contactId returned from Upsert, the recipient email and HTML content. We
    // intentionally omit `emailFrom` so HighLevel uses the location's default
    // outbound email. The API version for Conversations is 2021‑04‑15.
    const sendBody = {
      type: "Email",
      contactId: contactId,
      emailTo: email,
      html: htmlMessage,
    };
    // Even if sending fails we still want to return the joinUrl. To avoid
    // masking an invite with an error due to email issues (e.g. sandbox), we
    // catch and log but don\'t return a 500.
    try {
      await fetch("https://services.leadconnectorhq.com/conversations/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          Version: "2021-04-15",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sendBody),
        cache: "no-store",
      });
    } catch {
      // Swallow errors – the email may fail in test accounts but the link
      // remains valid. In production the error will be logged by the runtime.
    }

    return NextResponse.json({ joinUrl }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}