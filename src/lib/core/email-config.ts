import type { Db } from "../db";

/**
 * Whether email sending is set up (switched on, a From address, and a Resend
 * key saved), without touching the provider or the key itself. EMAIL_PROVIDER=mock
 * (development and tests) counts as set up.
 */
export async function emailConfigured(db: Db): Promise<boolean> {
  if (process.env.EMAIL_PROVIDER === "mock") return true;
  const envKey = Boolean(process.env.RESEND_API_KEY);
  const { rows } = await db.query<{ ok: boolean }>(
    `select coalesce((s.value->>'enabled')::boolean, false) and coalesce(s.value->>'from_email', '') <> ''
            and ($1::boolean or exists (select 1 from app_secrets k where k.key = 'resend_api_key')) as ok
       from (select (select value from app_settings where key = 'email') as value) s`,
    [envKey],
  );
  return Boolean(rows[0]?.ok);
}
