import { getDb, type Db } from "../db";
import { env } from "../env";
import { setIntegrationOverrides, type IntegrationOverrides } from "../integrations";
import { HttpError } from "../core/errors";
import { audit } from "../core/audit";
import { getSetting, setSetting, type IntegrationSettings } from "./settings";
import { ADMIN_SECRETS, allSecretStatus, decryptSecret, type AdminSecret, type SecretStatus } from "./secrets";

/**
 * Admin → Integrations: provider modes and API keys set by a super admin.
 * Values set here override the server environment; empty ones fall back to it.
 */
const KHALTI_URL = { live: "https://a.khalti.com", test: "https://dev.khalti.com" } as const;

async function decrypted(db: Db): Promise<Partial<Record<AdminSecret, string>>> {
  const { rows } = await db.query<{ key: string; value: { value?: string } }>("select key, value from app_secrets where key = any($1::text[])", [ADMIN_SECRETS as unknown as string[]]);
  const out: Partial<Record<AdminSecret, string>> = {};
  for (const r of rows) {
    const v = r.value?.value ? decryptSecret(r.value.value) : null;
    if (v) out[r.key as AdminSecret] = v;
  }
  return out;
}

export function overridesFrom(s: IntegrationSettings, k: Partial<Record<AdminSecret, string>>): IntegrationOverrides {
  const mode = (v: string) => (v === "env" ? undefined : v);
  return {
    smsProvider: mode(s.sms_provider),
    aakashAuthToken: k.aakash_auth_token,
    paymentGateway: mode(s.payment_gateway),
    khaltiSecretKey: k.khalti_secret_key,
    khaltiBaseUrl: s.khalti_env === "env" ? undefined : KHALTI_URL[s.khalti_env],
    fonepayMode: mode(s.fonepay_mode),
    fonepayMerchantCode: s.fonepay_merchant_code || undefined,
    fonepayUsername: k.fonepay_username,
    fonepayPassword: k.fonepay_password,
    fonepaySecretKey: k.fonepay_secret_key,
    whatsappProvider: mode(s.whatsapp_provider),
    whatsappAccessToken: k.whatsapp_access_token,
    whatsappAppSecret: k.whatsapp_app_secret,
    whatsappVerifyToken: k.whatsapp_verify_token,
  };
}

/** Load the admin-panel values into memory. Returns true when something changed. */
export async function refreshIntegrations(db: Db = getDb()): Promise<boolean> {
  const [s, k] = await Promise.all([getSetting("integrations", db), decrypted(db)]);
  return setIntegrationOverrides(overridesFrom(s, k));
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Start-up: load now, then every 30 s (a change made on another instance is picked up). */
export function startIntegrationsRefresh(): void {
  refreshIntegrations().catch((e) => console.warn(`[integrations] ${(e as Error).message}`));
  if (timer) return;
  timer = setInterval(() => refreshIntegrations().catch(() => undefined), 30_000);
  timer.unref?.();
}

export async function saveIntegrationSettings(actor: { id: string }, value: unknown, db: Db = getDb()): Promise<IntegrationSettings> {
  const parsed = value as Partial<IntegrationSettings>;
  // Test doubles never run in production: a "mock" SMS or payment provider would silently send nothing.
  if (env.isProd && [parsed.sms_provider, parsed.payment_gateway, parsed.fonepay_mode, parsed.whatsapp_provider].includes("mock")) {
    throw new HttpError(400, "Mock providers cannot be used in production.", "mock_in_production");
  }
  const saved = await setSetting(actor, "integrations", value, db);
  await refreshIntegrations(db);
  return saved;
}

export interface ProviderStatus {
  key: "sms" | "khalti" | "fonepay" | "whatsapp" | "email";
  mode: string;
  ready: boolean;
  missing: string[];
}

/** What each provider is using right now (after admin overrides), and what is missing. */
export async function integrationStatus(db: Db = getDb()): Promise<{ settings: IntegrationSettings; secrets: Record<AdminSecret, SecretStatus>; providers: ProviderStatus[] }> {
  await refreshIntegrations(db);
  const [settings, secrets, email] = await Promise.all([getSetting("integrations", db), allSecretStatus(db), getSetting("email", db)]);
  const has = (k: AdminSecret) => secrets[k].source !== "none";
  const providers: ProviderStatus[] = [];
  const sms = env.smsProvider;
  providers.push({ key: "sms", mode: sms, ready: sms === "mock" || (sms === "aakash" && has("aakash_auth_token")), missing: sms === "aakash" && !has("aakash_auth_token") ? ["Aakash auth token"] : [] });
  const pg = env.paymentGateway;
  providers.push({ key: "khalti", mode: `${pg}${pg === "khalti" ? ` · ${env.khalti.baseUrl.includes("dev.") ? "test" : "live"}` : ""}`, ready: pg !== "khalti" || has("khalti_secret_key"), missing: pg === "khalti" && !has("khalti_secret_key") ? ["Khalti secret key"] : [] });
  const f = env.fonepay;
  const fMissing = f.mode === "live" ? [!f.merchantCode && "merchant code", !has("fonepay_username") && "username", !has("fonepay_password") && "password", !has("fonepay_secret_key") && "secret key"].filter(Boolean) as string[] : [];
  providers.push({ key: "fonepay", mode: f.mode, ready: f.mode !== "live" || fMissing.length === 0, missing: fMissing });
  const w = env.whatsapp;
  const wMissing = w.provider === "meta" ? [!has("whatsapp_access_token") && "access token", !has("whatsapp_app_secret") && "app secret", !has("whatsapp_verify_token") && "verify token"].filter(Boolean) as string[] : [];
  providers.push({ key: "whatsapp", mode: w.provider, ready: w.provider !== "meta" || wMissing.length === 0, missing: wMissing });
  const eMissing = [!has("resend_api_key") && "Resend API key", !email.from_email && "From address", !email.enabled && "switched off"].filter(Boolean) as string[];
  providers.push({ key: "email", mode: email.enabled ? "resend" : "off", ready: eMissing.length === 0, missing: eMissing });
  return { settings, secrets, providers };
}

export async function auditIntegrationTest(actor: { id: string }, provider: string, ok: boolean, db: Db = getDb()): Promise<void> {
  await audit(db, { userId: actor.id, via: "web", scopes: [], locale: "en" }, "integration.tested", { type: "integration", id: provider }, { ok });
}
