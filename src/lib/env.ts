export const Env = {
  server: {
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ?? "",
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL ?? "",
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ?? "",
    // OAuth logging toggle (on/off)
    OAUTH_LOG: process.env.OAUTH_LOG ?? "off",
    // GHL server creds (read on server only)
    GHL_CLIENT_ID: process.env.GHL_CLIENT_ID ?? "",
    GHL_CLIENT_SECRET: process.env.GHL_CLIENT_SECRET ?? "",
    GHL_SHARED_SECRET_KEY: process.env.GHL_SHARED_SECRET_KEY ?? "",
    GHL_WEBHOOK_PUBLIC_KEY: process.env.GHL_WEBHOOK_PUBLIC_KEY ?? "",
    GHL_SCOPES: process.env.GHL_SCOPES ?? "",
    GHL_REDIRECT_PATH: process.env.GHL_REDIRECT_PATH ?? "/api/oauth/callback",
    NEXT_PUBLIC_APP_BASE_URL: process.env.NEXT_PUBLIC_APP_BASE_URL ?? "",
  },
  client: {
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV ?? "dev",
    NEXT_PUBLIC_APP_BASE_URL: process.env.NEXT_PUBLIC_APP_BASE_URL ?? "",
  },
};
