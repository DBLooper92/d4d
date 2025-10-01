import { NextResponse } from "next/server";
import * as crypto from "node:crypto";
import * as CryptoJS from "crypto-js";

export const runtime = "nodejs";

/**
 * HL sometimes returns a single AES string (CryptoJS "passphrase" format),
 * not an { iv, cipherText, tag } object. We support BOTH.
 * We normalize keys: userId/id, companyId/agencyId, role/userRole, type,
 * activeLocation/activeLocationId/locationId, userName, email
 */

type EncryptedPayloadObject = { iv: string; cipherText: string; tag: string };
type EncryptedPayload = EncryptedPayloadObject | string;

function b64urlToBuf(s: string): Buffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  return Buffer.from(b64 + "=".repeat(pad), "base64");
}

function deriveAesKeyFromSecret(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret, "utf8").digest(); // 32 bytes
}

function decryptGcm(p: EncryptedPayloadObject, secret: string): Record<string, unknown> {
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

function decryptCryptoJsString(enc: string, secret: string): Record<string, unknown> {
  const bytes = CryptoJS.AES.decrypt(enc, secret);
  const utf8 = bytes.toString(CryptoJS.enc.Utf8);
  if (!utf8) throw new Error("Failed to decrypt user data (empty result)");
  return JSON.parse(utf8) as Record<string, unknown>;
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

export async function POST(req: Request) {
  try {
    const { encryptedData } = (await req.json()) as { encryptedData: EncryptedPayload };

    const secret = process.env.GHL_SHARED_SECRET_KEY;
    if (!secret) {
      return NextResponse.json({ error: "Server not configured (GHL_SHARED_SECRET_KEY)" }, { status: 500 });
    }

    let raw: Record<string, unknown> = {};

    try {
      if (typeof encryptedData === "string") {
        raw = decryptCryptoJsString(encryptedData, secret);
      } else if (encryptedData && typeof encryptedData === "object") {
        raw = decryptGcm(encryptedData as EncryptedPayloadObject, secret);
      }
    } catch (e) {
      console.info("[oauth] sso decrypt failed", { err: (e as Error).message });
      raw = {};
    }

    // Light observability
    try {
      const keys = Object.keys(raw).slice(0, 30);
      console.info("[oauth] sso decode keys", { keys });
    } catch {
      /* noop */
    }

    // Normalize across HL variants
    const userId = pickString(raw, ["userId", "id"]);
    const companyId = pickString(raw, ["companyId", "agencyId", "company", "agency"]);
    const role = pickString(raw, ["role", "userRole"]);
    const type = pickString(raw, ["type"]);
    const activeLocation = pickString(raw, ["activeLocation", "activeLocationId", "locationId"]);
    const userName = pickString(raw, ["userName", "name"]);
    const email = pickString(raw, ["email"]);

    // Extra line that makes debugging crystal clear in Cloud Run logs
    console.info("[oauth] sso normalized", {
      haveUserId: !!userId,
      haveRole: !!role,
      haveCompanyId: !!companyId,
      haveActiveLocation: !!activeLocation,
    });

    return NextResponse.json(
      {
        activeLocationId: activeLocation ?? null,
        activeCompanyId: companyId ?? null,
        userId: userId ?? null,
        role: role ?? null,
        type: type ?? null,
        userName: userName ?? null,
        email: email ?? null,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Failed to decode user context" }, { status: 400 });
  }
}
