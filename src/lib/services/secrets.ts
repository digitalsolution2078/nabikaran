import { getDb, type Db } from "../db";
import { audit } from "../core/audit";

/**
 * Server-only secrets an admin pastes in the admin panel (e.g. the Resend API
 * key). Stored in app_secrets; never returned to the browser, only a masked
 * status (set / last 4 characters / when).
 */
export const ADMIN_SECRETS = ["resend_api_key"] as const;
export type AdminSecret = (typeof ADMIN_SECRETS)[number];

interface Stored {
  value: string;
  set_at: string;
  set_by: string | null;
}

export async function getSecret(key: AdminSecret, db: Db = getDb()): Promise<string | null> {
  const { rows } = await db.query<{ value: Stored }>("select value from app_secrets where key = $1", [key]);
  const v = rows[0]?.value?.value;
  return typeof v === "string" && v ? v : null;
}

export interface SecretStatus {
  set: boolean;
  last4: string | null;
  setAt: string | null;
}

export async function secretStatus(key: AdminSecret, db: Db = getDb()): Promise<SecretStatus> {
  const { rows } = await db.query<{ value: Stored }>("select value from app_secrets where key = $1", [key]);
  const s = rows[0]?.value;
  if (!s?.value) return { set: false, last4: null, setAt: null };
  return { set: true, last4: s.value.slice(-4), setAt: s.set_at };
}

/** Save (or clear with null). The audit row records that it changed, never the value. */
export async function setSecret(actor: { id: string }, key: AdminSecret, value: string | null, db: Db = getDb()): Promise<SecretStatus> {
  if (value === null) {
    await db.query("delete from app_secrets where key = $1", [key]);
  } else {
    const stored: Stored = { value, set_at: new Date().toISOString(), set_by: actor.id };
    await db.query(
      "insert into app_secrets (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, created_at = now()",
      [key, JSON.stringify(stored)],
    );
  }
  await audit(db, { userId: actor.id, via: "web", scopes: [], locale: "en" }, value === null ? "secret.cleared" : "secret.updated", { type: "app_secret", id: key }, { last4: value ? value.slice(-4) : null });
  return secretStatus(key, db);
}
