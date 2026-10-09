/**
 * Server-side configuration. Never import from client components.
 * Secrets stay in the environment / secrets vault; nothing here is NEXT_PUBLIC_.
 */
function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing required env var ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === "production";

export const env = {
  isProd,
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** HS256 key for session cookies. */
  sessionSecret: () => req("SESSION_SECRET", isProd ? undefined : "dev-only-session-secret-change-me"),
  otpPepper: () => req("OTP_PEPPER", isProd ? undefined : "dev-only-otp-pepper"),
  /** Shared secret for internal worker routes (/api/jobs/*). */
  workerToken: () => req("WORKER_TOKEN", isProd ? undefined : "dev-worker-token"),

  /** OAuth issuer (authorization server) = the web app origin. */
  oauthIssuer: process.env.OAUTH_ISSUER ?? process.env.APP_URL ?? "http://localhost:3000",
  /** Canonical MCP resource identifier that tokens are bound to (RFC 8707). */
  mcpResource: process.env.MCP_PUBLIC_URL ?? "http://localhost:3000/mcp",
  oauth: {
    codeTtlSeconds: 600,
    accessTtlSeconds: 3600,
    refreshTtlSeconds: 30 * 24 * 3600,
  },

  smsProvider: process.env.SMS_PROVIDER ?? (isProd ? "aakash" : "mock"),
  aakash: {
    authToken: process.env.AAKASH_AUTH_TOKEN ?? "",
    sendUrl: process.env.AAKASH_SEND_URL ?? "https://sms.aakashsms.com/sms/v3/send",
    reportUrl: process.env.AAKASH_REPORT_URL ?? "https://sms.aakashsms.com/sms/v3/report",
  },

  paymentGateway: process.env.PAYMENT_GATEWAY ?? (isProd ? "khalti" : "mock"),
  khalti: {
    secretKey: process.env.KHALTI_SECRET_KEY ?? "",
    baseUrl: process.env.KHALTI_BASE_URL ?? (isProd ? "https://a.khalti.com" : "https://dev.khalti.com"),
  },

  /**
   * Fonepay dynamic QR (merchant API). "live" needs all four credentials from
   * Fonepay / the acquiring bank; "mock" is for development and tests; "off"
   * (default) keeps the static QR + admin verification flow.
   */
  fonepay: {
    mode: (process.env.FONEPAY_MODE ?? "off") as "off" | "live" | "mock",
    apiBase: process.env.FONEPAY_API_BASE ?? "https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty",
    merchantCode: process.env.FONEPAY_MERCHANT_CODE ?? "",
    username: process.env.FONEPAY_USERNAME ?? "",
    password: process.env.FONEPAY_PASSWORD ?? "",
    secretKey: process.env.FONEPAY_SECRET_KEY ?? "",
  },

  otp: {
    ttlSeconds: 300,
    maxAttempts: 5,
    perPhonePer15Min: 3,
    perIpPerHour: 10,
  },
  session: {
    cookieName: "nb_session",
    ttlSeconds: 30 * 24 * 3600,
  },
  dispatcher: {
    batchSize: 50,
    leaseSeconds: 120,
  },
};
