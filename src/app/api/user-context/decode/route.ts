import { NextResponse } from "next/server";
import * as crypto from "node:crypto";
import * as CryptoJS from "crypto-js";

export const runtime = "nodejs";

/**
 * HL sometimes returns a single AES string (CryptoJS "passphrase" format),
 * not an { iv, cipherText, tag } object. We support BOTH.
 * We only return fields needed for routing: company & location (plus optional display bits).
 */

type EncryptedPayloadObject = { iv: string; cipherText: string; tag: string };
type EncryptedPayload = EncryptedPayloadObject | string;

function b64urlToBuf(s: string): Buffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? 4 - (b64.length % 4) : 0;
  return Buffer.from(b64 + "=".repeat(pad), "base64");
}

function deriveAesKeyFromSecret(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
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

    try {
      const keys = Object.keys(raw).slice(0, 30);
      console.info("[oauth] sso decode keys", { keys });
    } catch { /* noop */ }

    // Only return what we need now, plus the HighLevel userId (if present).  The
    // decrypted payload may contain nested `user.id` or top‑level `userId`/`id`.
    const companyId = pickString(raw, ["companyId", "agencyId", "company", "agency"]);
    const type = pickString(raw, ["type"]);
    const activeLocation = pickString(raw, ["activeLocation", "activeLocationId", "locationId"]);
    const userName = pickString(raw, ["userName"]);
    const email = pickString(raw, ["email"]);
    let userId: string | null = null;
    try {
      if (raw && typeof raw === "object") {
        const userObj = (raw as Record<string, unknown>)["user"] as Record<string, unknown> | undefined;
        const nestedId = userObj && typeof userObj["id"] === "string" ? (userObj["id"] as string).trim() : "";
        if (nestedId) {
          userId = nestedId;
        } else {
          userId = pickString(raw, ["userId", "id"]);
        }
      }
    } catch {
      /* ignore */
    }
    return NextResponse.json(
      {
        activeLocationId: activeLocation ?? null,
        activeCompanyId: companyId ?? null,
        type: type ?? null,
        userName: userName ?? null,
        email: email ?? null,
        userId: userId ?? null,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Failed to decode user context" }, { status: 400 });
  }
}
