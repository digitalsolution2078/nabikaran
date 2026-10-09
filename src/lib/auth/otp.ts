import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../env";
import { getDb, type Db } from "../db";
import { normalizeNepalPhone, redactPhone } from "../phone";
import { getSmsProvider } from "../providers/sms";
import { getSetting } from "../services/settings";
import { isAdminRole } from "./rbac";

/** English only, GSM-7, single segment. */
export function otpMessage(code: string): string {
  return `Nabikaran login code: ${code}. Valid for 5 minutes. Do not share this code with anyone.`;
}

/**
 * Phone OTP flow with abuse controls (PRD FR-01, §11):
 *  - per-phone and per-IP request caps (DB-counted, survives restarts)
 *  - 6-digit code, hashed with a server pepper, 5 minute TTL, 5 attempts
 *  - single use (consumed_at), replay-safe
 *  - the SMS is English-only GSM-7 text (one segment, cheapest to send)
 *  - each SUCCESSFUL sign-in charges the user's wallet the configured fee
 *    (app_settings.signin.fee_credits, default 1). The fee may take the
 *    balance below zero; a later top-up offsets it. Codes that are never
 *    verified are not charged to anyone's wallet, so nobody can drain a
 *    stranger's balance by requesting codes for their number.
 */
export class OtpError extends Error {
  constructor(public readonly code: "invalid_phone" | "rate_limited" | "invalid_code" | "expired" | "too_many_attempts" | "send_failed", message: string) {
    super(message);
  }
}

export function hashOtp(phone: string, code: string): string {
  return createHash("sha256").update(`${env.otpPepper()}|${phone}|${code}`).digest("hex");
}

export function hashIp(ip: string | null | undefined): string | null {
  return ip ? createHash("sha256").update(`${env.otpPepper()}|ip|${ip}`).digest("hex").slice(0, 32) : null;
}

export interface RequestOtpInput {
  phone: string;
  ip?: string | null;
  userAgent?: string | null;
}

export async function requestOtp(input: RequestOtpInput, db: Db = getDb()): Promise<{ phoneE164: string; devCode?: string }> {
  const phoneE164 = normalizeNepalPhone(input.phone);
  if (!phoneE164) throw new OtpError("invalid_phone", "Enter a valid Nepal mobile number");
  const ipHash = hashIp(input.ip);

  const { rows: phoneCount } = await db.query<{ n: string }>(
    "select count(*)::text as n from phone_verifications where phone_e164 = $1 and created_at > now() - interval '15 minutes'",
    [phoneE164],
  );
  if (Number(phoneCount[0]?.n ?? 0) >= env.otp.perPhonePer15Min) throw new OtpError("rate_limited", "Too many codes requested. Try again in 15 minutes.");
  if (ipHash) {
    const { rows: ipCount } = await db.query<{ n: string }>(
      "select count(*)::text as n from phone_verifications where ip_hash = $1 and created_at > now() - interval '1 hour'",
      [ipHash],
    );
    if (Number(ipCount[0]?.n ?? 0) >= env.otp.perIpPerHour) throw new OtpError("rate_limited", "Too many requests from this network.");
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.query(
    `insert into phone_verifications (phone_e164, otp_hash, expires_at, ip_hash, user_agent)
     values ($1, $2, now() + make_interval(secs => $3), $4, $5)`,
    [phoneE164, hashOtp(phoneE164, code), env.otp.ttlSeconds, ipHash, (input.userAgent ?? "").slice(0, 200)],
  );

  const provider = getSmsProvider();
  const outcome = await provider.send({
    to: phoneE164,
    text: otpMessage(code),
    idempotencyKey: `otp:${phoneE164}:${Date.now()}`,
  });
  if (outcome.kind === "rejected") {
    console.warn(`[otp] send rejected for ${redactPhone(phoneE164)}: ${outcome.reason}`);
    throw new OtpError("send_failed", "Could not send the code right now.");
  }
  return { phoneE164, devCode: env.isProd ? undefined : code };
}

export async function verifyOtp(phone: string, code: string, db: Db = getDb()): Promise<{ userId: string; isNew: boolean; feeCharged: number }> {
  const phoneE164 = normalizeNepalPhone(phone);
  if (!phoneE164) throw new OtpError("invalid_phone", "Enter a valid Nepal mobile number");
  if (!/^\d{6}$/.test(code)) throw new OtpError("invalid_code", "Enter the 6-digit code");

  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ id: string; otp_hash: string; expires_at: string; attempts: number }>(
      `select id, otp_hash, expires_at, attempts from phone_verifications
        where phone_e164 = $1 and consumed_at is null
        order by created_at desc limit 1 for update`,
      [phoneE164],
    );
    const v = rows[0];
    if (!v) throw new OtpError("expired", "No active code. Request a new one.");
    if (new Date(v.expires_at).getTime() < Date.now()) throw new OtpError("expired", "Code expired. Request a new one.");
    if (v.attempts >= env.otp.maxAttempts) throw new OtpError("too_many_attempts", "Too many wrong attempts. Request a new code.");

    const expected = Buffer.from(v.otp_hash, "hex");
    const actual = Buffer.from(hashOtp(phoneE164, code), "hex");
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!ok) {
      await tx.query("update phone_verifications set attempts = attempts + 1 where id = $1", [v.id]);
      throw new OtpError("invalid_code", "Incorrect code");
    }

    const { rows: users } = await tx.query<{ id: string }>("select id from users where phone_e164 = $1", [phoneE164]);
    let userId = users[0]?.id;
    let isNew = false;
    if (!userId) {
      const { rows: created } = await tx.query<{ id: string }>(
        "insert into users (phone_e164, phone_verified_at) values ($1, now()) returning id",
        [phoneE164],
      );
      userId = created[0].id;
      isNew = true;
      await tx.query("insert into wallets (user_id) values ($1) on conflict do nothing", [userId]);
    } else {
      await tx.query("update users set phone_verified_at = coalesce(phone_verified_at, now()), updated_at = now() where id = $1", [userId]);
    }
    await tx.query("update phone_verifications set consumed_at = now(), user_id = $2 where id = $1", [v.id, userId]);
    await tx.query("insert into audit_events (actor_user_id, action, target_type, target_id) values ($1, 'auth.otp_verified', 'user', $2)", [userId, userId]);

    const signin = await getSetting("signin", tx);
    const { rows: roleRows } = await tx.query<{ role: string }>("select role from users where id = $1", [userId]);
    const exempt = isAdminRole(roleRows[0]?.role) && !signin.charge_staff;
    let feeCharged = 0;
    if (!exempt && signin.fee_credits > 0) {
      const { rows: fee } = await tx.query<{ wallet_charge_signin_fee: boolean }>(
        "select wallet_charge_signin_fee($1, $2, $3)",
        [userId, v.id, signin.fee_credits],
      );
      if (fee[0]?.wallet_charge_signin_fee) feeCharged = signin.fee_credits;
    }
    return { userId, isNew, feeCharged };
  });
}
