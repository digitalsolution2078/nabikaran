import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { getDb, type Db } from "../db";
import { HttpError } from "../core/errors";
import { audit } from "../core/audit";
import { decryptSecret, encryptSecret } from "./secrets";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../auth/totp";
import { formatPhoneLocal } from "../phone";

/**
 * Optional two-step sign-in with an authenticator app (Google Authenticator,
 * Microsoft Authenticator, Authy…). When on, every sign-in (SMS code, PIN or
 * email) also needs a 6-digit app code or a one-time recovery code.
 */
const who = (id: string) => ({ userId: id, via: "web" as const, scopes: [], locale: "en" });
const hashRecovery = (code: string) => createHash("sha256").update(`nabikaran-recovery|${code.toUpperCase().replace(/[^A-Z0-9]/g, "")}`).digest("hex");
const RECOVERY_COUNT = 10;

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryLeft: number;
}

export async function twoFactorStatus(userId: string, db: Db = getDb()): Promise<TwoFactorStatus> {
  const { rows } = await db.query<{ totp_enabled_at: string | null; left: number }>(
    "select totp_enabled_at, (select count(*)::int from totp_recovery_codes r where r.user_id = u.id and r.used_at is null) as left from users u where id = $1",
    [userId],
  );
  return { enabled: Boolean(rows[0]?.totp_enabled_at), enabledAt: rows[0]?.totp_enabled_at ? new Date(rows[0].totp_enabled_at).toISOString() : null, recoveryLeft: rows[0]?.left ?? 0 };
}

export async function twoFactorRequired(userId: string, db: Db = getDb()): Promise<boolean> {
  const { rows } = await db.query("select 1 from users where id = $1 and totp_enabled_at is not null", [userId]);
  return Boolean(rows[0]);
}

/** Step 1: a new secret (not enforced until confirmed). Returns what the app needs. */
export async function beginSetup(userId: string, db: Db = getDb()): Promise<{ secret: string; uri: string; qrSvg: string }> {
  const { rows } = await db.query<{ phone_e164: string; totp_enabled_at: string | null }>("select phone_e164, totp_enabled_at from users where id = $1", [userId]);
  if (!rows[0]) throw new HttpError(404, "Account not found", "not_found");
  if (rows[0].totp_enabled_at) throw new HttpError(409, "The authenticator app is already on. Turn it off first to set up a new phone.", "already_enabled");
  const secret = generateTotpSecret();
  await db.query("update users set totp_secret = $2, totp_last_step = null where id = $1", [userId, encryptSecret(secret)]);
  const uri = otpauthUri(secret, formatPhoneLocal(rows[0].phone_e164));
  const qrSvg = await QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 220 });
  return { secret: secret.replace(/(.{4})/g, "$1 ").trim(), uri, qrSvg };
}

async function secretOf(userId: string, db: Db): Promise<{ secret: string; lastStep: number | null; enabled: boolean } | null> {
  const { rows } = await db.query<{ totp_secret: string | null; totp_last_step: string | null; totp_enabled_at: string | null }>(
    "select totp_secret, totp_last_step::text, totp_enabled_at from users where id = $1 for update",
    [userId],
  );
  const r = rows[0];
  if (!r?.totp_secret) return null;
  const secret = decryptSecret(r.totp_secret);
  if (!secret) return null;
  return { secret, lastStep: r.totp_last_step === null ? null : Number(r.totp_last_step), enabled: Boolean(r.totp_enabled_at) };
}

function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_COUNT }, () => {
    const s = randomBytes(5).toString("hex").toUpperCase(); // 40 bits each
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** Step 2: the first code from the app turns it on and returns recovery codes (shown once). */
export async function confirmSetup(userId: string, code: string, db: Db = getDb()): Promise<{ recoveryCodes: string[] }> {
  return db.tx(async (tx) => {
    const s = await secretOf(userId, tx);
    if (!s) throw new HttpError(400, "Start the set-up again.", "setup_missing");
    if (s.enabled) throw new HttpError(409, "The authenticator app is already on.", "already_enabled");
    const step = verifyTotp(s.secret, code.trim(), s.lastStep);
    if (step === null) throw new HttpError(400, "That code is not right. Check the phone's time and try the newest code.", "invalid_code");
    await tx.query("update users set totp_enabled_at = now(), totp_last_step = $2 where id = $1", [userId, step]);
    await tx.query("delete from totp_recovery_codes where user_id = $1", [userId]);
    const codes = newRecoveryCodes();
    for (const c of codes) await tx.query("insert into totp_recovery_codes (user_id, code_hash) values ($1, $2)", [userId, hashRecovery(c)]);
    await audit(tx, who(userId), "auth.2fa_enabled", { type: "user", id: userId }, {});
    return { recoveryCodes: codes };
  });
}

/**
 * Check an app code or a recovery code for this account. Used at sign-in and to
 * confirm sensitive changes. Returns how it was satisfied, or throws invalid_code.
 */
export async function verifySecondFactor(userId: string, code: string, db: Db = getDb()): Promise<"app" | "recovery"> {
  const c = code.trim();
  return db.tx(async (tx) => {
    const s = await secretOf(userId, tx);
    if (!s || !s.enabled) throw new HttpError(400, "Two-step sign-in is not on for this account.", "not_enabled");
    if (/^\d{6}$/.test(c)) {
      const step = verifyTotp(s.secret, c, s.lastStep);
      if (step === null) throw new HttpError(401, "That code is not right or was already used. Wait for the next code.", "invalid_code");
      await tx.query("update users set totp_last_step = $2 where id = $1", [userId, step]);
      return "app";
    }
    const { rows } = await tx.query<{ id: string }>(
      "update totp_recovery_codes set used_at = now() where id = (select id from totp_recovery_codes where user_id = $1 and code_hash = $2 and used_at is null limit 1) returning id",
      [userId, hashRecovery(c)],
    );
    if (!rows[0]) throw new HttpError(401, "That code is not right.", "invalid_code");
    await audit(tx, who(userId), "auth.2fa_recovery_used", { type: "user", id: userId }, {});
    return "recovery";
  });
}

/** Turn off (needs a current app or recovery code). */
export async function disableTwoFactor(userId: string, code: string, db: Db = getDb()): Promise<void> {
  await verifySecondFactor(userId, code, db);
  await db.query("update users set totp_secret = null, totp_enabled_at = null, totp_last_step = null where id = $1", [userId]);
  await db.query("delete from totp_recovery_codes where user_id = $1", [userId]);
  await audit(db, who(userId), "auth.2fa_disabled", { type: "user", id: userId }, {});
}

/** New recovery codes (needs a current app code); the old ones stop working. */
export async function regenerateRecoveryCodes(userId: string, code: string, db: Db = getDb()): Promise<{ recoveryCodes: string[] }> {
  if (!/^\d{6}$/.test(code.trim())) throw new HttpError(400, "Enter a code from the app.", "invalid_code");
  await verifySecondFactor(userId, code, db);
  const codes = newRecoveryCodes();
  await db.tx(async (tx) => {
    await tx.query("delete from totp_recovery_codes where user_id = $1", [userId]);
    for (const c of codes) await tx.query("insert into totp_recovery_codes (user_id, code_hash) values ($1, $2)", [userId, hashRecovery(c)]);
  });
  await audit(db, who(userId), "auth.2fa_recovery_regenerated", { type: "user", id: userId }, {});
  return { recoveryCodes: codes };
}

/** Super admin: the customer lost their phone and recovery codes. Logged. */
export async function adminResetTwoFactor(actor: { id: string }, userId: string, reason: string, db: Db = getDb()): Promise<void> {
  if (reason.trim().length < 5) throw new HttpError(400, "Write why (at least 5 characters).", "reason_required");
  if (actor.id === userId) throw new HttpError(400, "You cannot reset your own two-step sign-in.", "self_reset");
  const { rowCount } = await db.query("update users set totp_secret = null, totp_enabled_at = null, totp_last_step = null where id = $1 and totp_enabled_at is not null", [userId]);
  if (!rowCount) throw new HttpError(409, "Two-step sign-in is not on for this account.", "not_enabled");
  await db.query("delete from totp_recovery_codes where user_id = $1", [userId]);
  await audit(db, who(actor.id), "auth.2fa_reset_by_admin", { type: "user", id: userId }, { reason: reason.trim() });
}
