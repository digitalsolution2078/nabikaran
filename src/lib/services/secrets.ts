import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getDb, type Db } from "../db";
import { env } from "../env";
import { audit } from "../core/audit";

/**
 * Server-only secrets a super admin pastes in the admin panel (provider API
 * keys). Stored in app_secrets, encrypted at rest (AES-256-GCM with a key
 * derived from SECRETS_KEY, or SESSION_SECRET when that is not set). Never
 * returned to the browser: only a masked status (set / last 4 / when / where).
 */
export const ADMIN_SECRETS = [
  "resend_api_key",
  "aakash_auth_token",
  "khalti_secret_key",
  "fonepay_username",
  "fonepay_password",
  "fonepay_secret_key",
  "whatsapp_access_token",
  "whatsapp_app_secret",
  "whatsapp_verify_token",
] as const;
export type AdminSecret = (typeof ADMIN_SECRETS)[number];

/** The server environment variable each secret falls back to. */
export const SECRET_ENV: Record<AdminSecret, string> = {
  resend_api_key: "RESEND_API_KEY",
  aakash_auth_token: "AAKASH_AUTH_TOKEN",
  khalti_secret_key: "KHALTI_SECRET_KEY",
  fonepay_username: "FONEPAY_USERNAME",
  fonepay_password: "FONEPAY_PASSWORD",
  fonepay_secret_key: "FONEPAY_SECRET_KEY",
  whatsapp_access_token: "WHATSAPP_ACCESS_TOKEN",
  whatsapp_app_secret: "WHATSAPP_APP_SECRET",
  whatsapp_verify_token: "WHATSAPP_VERIFY_TOKEN",
};

interface Stored {
  value: string;
  set_at: string;
  set_by: string | null;
}

const PREFIX = "enc:v1:";
const key = () => createHash("sha256").update(`nabikaran-secrets|${process.env.SECRETS_KEY || env.sessionSecret()}`).digest();

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}

/** Null when it cannot be decrypted (e.g. the server key changed). Plain values (older rows) pass through. */
export function decryptSecret(stored: string): string | null {
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

async function readStored(db: Db, keys: readonly string[]): Promise<Map<string, Stored>> {
  const { rows } = await db.query<{ key: string; value: Stored }>("select key, value from app_secrets where key = any($1::text[])", [keys as string[]]);
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** The admin-panel value only (no environment fallback). */
export async function getSecret(k: AdminSecret, db: Db = getDb()): Promise<string | null> {
  const s = (await readStored(db, [k])).get(k);
  if (!s?.value) return null;
  return decryptSecret(s.value);
}

export interface SecretStatus {
  set: boolean;
  last4: string | null;
  setAt: string | null;
  /** Where the value in use comes from. */
  source?: "admin" | "env" | "none";
  /** Saved in the panel but cannot be decrypted with the current server key. */
  unreadable?: boolean;
}

const mask = (v: string) => v.slice(-4);

export async function secretStatus(k: AdminSecret, db: Db = getDb()): Promise<SecretStatus> {
  return (await allSecretStatus(db))[k];
}

export async function allSecretStatus(db: Db = getDb()): Promise<Record<AdminSecret, SecretStatus>> {
  const stored = await readStored(db, ADMIN_SECRETS);
  const out = {} as Record<AdminSecret, SecretStatus>;
  for (const k of ADMIN_SECRETS) {
    const s = stored.get(k);
    const plain = s?.value ? decryptSecret(s.value) : null;
    const fromEnv = process.env[SECRET_ENV[k]] ?? "";
    if (plain) out[k] = { set: true, last4: mask(plain), setAt: s!.set_at, source: "admin" };
    else if (fromEnv) out[k] = { set: false, last4: mask(fromEnv), setAt: null, source: "env", unreadable: Boolean(s?.value) };
    else out[k] = { set: false, last4: null, setAt: null, source: "none", unreadable: Boolean(s?.value) };
  }
  return out;
}

/** Save (or clear with null). The audit row records that it changed, never the value. */
export async function setSecret(actor: { id: string }, k: AdminSecret, value: string | null, db: Db = getDb()): Promise<SecretStatus> {
  if (value === null) {
    await db.query("delete from app_secrets where key = $1", [k]);
  } else {
    const stored: Stored = { value: encryptSecret(value), set_at: new Date().toISOString(), set_by: actor.id };
    await db.query(
      "insert into app_secrets (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, created_at = now()",
      [k, JSON.stringify(stored)],
    );
  }
  await audit(db, { userId: actor.id, via: "web", scopes: [], locale: "en" }, value === null ? "secret.cleared" : "secret.updated", { type: "app_secret", id: k }, { last4: value ? mask(value) : null });
  return secretStatus(k, db);
}
