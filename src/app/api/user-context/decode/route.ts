// src/app/api/user-context/decode/route.ts
import { NextResponse } from "next/server";
import * as crypto from "node:crypto";

export const runtime = "nodejs";

// Accepts either the documented HL payload shape { iv, cipherText, tag } with base64url strings,
// or (for forward-compat) a plain encrypted string. We only implement the structured variant here.
type EncryptedPayload = { iv: string; cipherText: string; tag: string };

function b64urlToBuf(s: string): Buffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  return Buffer.from(b64 + "=".repeat(pad), "base64");
}

function deriveAesKeyFromSecret(secret: string): Buffer {
  // Derive a 32-byte key deterministically from the shared secret
  return crypto.createHash("sha256").update(secret, "utf8").digest(); // 32 bytes
}

function decryptPayload(p: EncryptedPayload, secret: string): Record<string, unknown> {
  const key = deriveAesKeyFromSecret(secret);
  const iv = b64urlToBuf(p.iv);
  const tag = b64urlToBuf(p.tag);
  const ct = b64urlToBuf(p.cipherText);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  const txt = dec.toString("utf8");
  return JSON.parse(txt) as Record<string, unknown>;
}

export async function POST(req: Request) {
  try {
    const { encryptedData } = (await req.json()) as { encryptedData: EncryptedPayload | string };

    const secret = process.env.GHL_SHARED_SECRET_KEY;
    if (!secret) {
      return NextResponse.json({ error: "Server not configured (GHL_SHARED_SECRET_KEY)" }, { status: 500 });
    }

    let raw: Record<string, unknown> | null = null;

    if (encryptedData && typeof encryptedData === "object" && encryptedData !== null) {
      raw = decryptPayload(encryptedData as EncryptedPayload, secret);
    } else {
      // If a future HL payload sends a single encrypted string, return a minimal shape instead of failing hard.
      raw = {};
    }

    // Normalize to the fields we want on the client & signup:
    // Fields can include:
    // userId, companyId, role, type ('agency'|'location'), activeLocation, userName, email, isAgencyOwner
    const userId = typeof raw.userId === "string" ? raw.userId : null;
    const companyId = typeof raw.companyId === "string" ? raw.companyId : null;
    const role = typeof raw.role === "string" ? raw.role : null;
    const type = typeof raw.type === "string" ? raw.type : null;
    const activeLocation = typeof raw.activeLocation === "string" ? raw.activeLocation : null;
    const userName = typeof raw.userName === "string" ? raw.userName : null;
    const email = typeof raw.email === "string" ? raw.email : null;
    const isAgencyOwner = typeof raw.isAgencyOwner === "boolean" ? raw.isAgencyOwner : null;

    return NextResponse.json(
      {
        activeLocationId: activeLocation,
        activeCompanyId: companyId,
        userId,
        role,
        type,
        userName,
        email,
        isAgencyOwner,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Failed to decode user context" }, { status: 400 });
  }
}
