import { NextResponse } from "next/server";
import * as crypto from "node:crypto";

export const runtime = "nodejs";

type EncryptedPayload = { iv: string; cipherText: string; tag: string };

function b64urlToBuf(s: string): Buffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  return Buffer.from(b64 + "=".repeat(pad), "base64");
}

function deriveAesKeyFromSecret(secret: string): Buffer {
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

// ---------- Safe pickers (no `any`) ----------
function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

export async function POST(req: Request) {
  try {
    const { encryptedData } = (await req.json()) as { encryptedData: EncryptedPayload | string };

    const secret = process.env.GHL_SHARED_SECRET_KEY;
    if (!secret) {
      return NextResponse.json({ error: "Server not configured (GHL_SHARED_SECRET_KEY)" }, { status: 500 });
    }

    // Decrypt to a generic record (no `any`)
    let raw: Record<string, unknown> = {};
    if (encryptedData && typeof encryptedData === "object" && encryptedData !== null) {
      raw = decryptPayload(encryptedData as EncryptedPayload, secret);
    }

    // Light observability: which keys were present?
    try {
      const keys = Object.keys(raw).slice(0, 30);
      console.info("[oauth] sso decode keys", { keys });
    } catch {
      /* noop */
    }

    // Normalize across HL variants (per docs)
    // https://marketplace.gohighlevel.com/docs/other/user-context-marketplace-apps/index.html
    const userId = pickString(raw, ["userId", "id"]);
    const companyId = pickString(raw, ["companyId", "agencyId", "company", "agency"]);
    const role = pickString(raw, ["role", "userRole"]); // some payloads use userRole
    const type = pickString(raw, ["type"]);
    const activeLocation = pickString(raw, ["activeLocation", "activeLocationId", "locationId"]);
    const userName = pickString(raw, ["userName"]);
    const email = pickString(raw, ["email"]);

    return NextResponse.json(
      {
        activeLocationId: activeLocation,
        activeCompanyId: companyId,
        userId,
        role,
        type,
        userName,
        email,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Failed to decode user context" }, { status: 400 });
  }
}
