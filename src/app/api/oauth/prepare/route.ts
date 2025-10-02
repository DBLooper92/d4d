// File: src/app/api/oauth/prepare/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { getGhlConfig, ghlAuthBase, olog } from "@/lib/ghl";

export const runtime = "nodejs"; // needs Node APIs (cookies/crypto)

export async function GET(request: Request) {
  const { clientId, scope, redirectUri, baseApp } = getGhlConfig();

  const nonce = crypto.randomBytes(16).toString("base64url");
  // 10 minutes validity
  const ck = await cookies();
  ck.set({
    name: "d4d_oauth_state",
    value: nonce,
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 600,
    path: "/",
  });

  const urlIn = new URL(request.url);
  const returnTo = urlIn.searchParams.get("returnTo") || `${baseApp}/app`;
  const state = [nonce, Buffer.from(returnTo, "utf8").toString("base64url")].join("|");

  const auth = new URL(ghlAuthBase());
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", clientId);
  auth.searchParams.set("redirect_uri", redirectUri);
  if (scope) auth.searchParams.set("scope", scope);
  // DO NOT set user_type here; let GHL set it based on where the user clicked Install
  auth.searchParams.set("state", state);

  olog("prepare redirect", { redirectUri, scope, stateEnc: state.slice(0, 12) + "…" });

  return NextResponse.redirect(auth.toString(), { status: 302 });
}
