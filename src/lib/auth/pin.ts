import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { env } from "../env";
import { getDb, type Db } from "../db";
import { normalizeNepalPhone } from "../phone";
import { getSetting } from "../services/settings";
import { isAdminRole } from "./rbac";

/**
 * Optional quick sign-in with mobile number + PIN (no OTP SMS, so no sign-in fee).
 *  - 4 to 6 digits; obvious PINs (1111, 1234, 4321, the end of the phone number) are refused
 *  - stored as scrypt(pepper|pin) with a per-user salt; the PIN itself is never stored
 *  - after max_attempts wrong PINs the PIN locks; only a normal OTP sign-in unlocks it
 *  - staff accounts (any admin role) must always use OTP
 *  - every failure returns the same message, so a PIN attempt cannot tell whether a number has an account
 */
const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export class PinError extends Error {
  constructor(public readonly code: "invalid_pin_format" | "weak_pin" | "invalid_credentials" | "pin_locked" | "pin_disabled" | "pin_not_for_staff" | "wrong_current_pin" | "no_pin", message: string) {
    super(message);
  }
}

async function derive(pin: string, salt: Buffer): Promise<Buffer> {
  return scrypt(`${env.otpPepper()}|pin|${pin}`, salt, 32);
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  return `s1$${salt.toString("hex")}$${(await derive(pin, salt)).toString("hex")}`;
}

export async function checkPin(pin: string, stored: string | null): Promise<boolean> {
  const [v, saltHex, hashHex] = (stored ?? "").split("$");
  // Always do the work, so timing does not reveal whether a PIN exists.
  const salt = v === "s1" && saltHex ? Buffer.from(saltHex, "hex") : Buffer.alloc(16);
  const got = await derive(pin, salt);
  if (v !== "s1" || !hashHex) return false;
  const want = Buffer.from(hashHex, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

export function pinProblem(pin: string, phoneE164?: string | null): PinError | null {
  if (!/^\d{4,6}$/.test(pin)) return new PinError("invalid_pin_format", "PIN must be 4 to 6 digits.");
  const digits = pin.split("").map(Number);
  const same = digits.every((d) => d === digits[0]);
  const up = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 1) % 10);
  const down = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 9) % 10);
  const phoneTail = phoneE164 ? phoneE164.replace(/\D/g, "").endsWith(pin) : false;
  if (same || up || down || phoneTail) return new PinError("weak_pin", "Choose a less obvious PIN (not repeated or sequential digits, and not the end of your phone number).");
  return null;
}

export async function pinStatus(userId: string, db: Db = getDb()): Promise<{ enabled: boolean; hasPin: boolean; locked: boolean; setAt: string | null; staff: boolean }> {
  const [s, { rows }] = await Promise.all([
    getSetting("pin", db),
    db.query<{ pin_hash: string | null; pin_locked: boolean; pin_set_at: unknown; role: string }>("select pin_hash, pin_locked, pin_set_at, role from users where id = $1", [userId]),
  ]);
  const u = rows[0];
  return { enabled: s.enabled, hasPin: Boolean(u?.pin_hash), locked: Boolean(u?.pin_locked), setAt: u?.pin_set_at ? new Date(u.pin_set_at as string).toISOString() : null, staff: isAdminRole(u?.role) };
}

export async function setPin(userId: string, pin: string, currentPin: string | null | undefined, db: Db = getDb()): Promise<void> {
  if (!(await getSetting("pin", db)).enabled) throw new PinError("pin_disabled", "PIN sign-in is turned off.");
  const { rows } = await db.query<{ phone_e164: string; pin_hash: string | null; role: string }>("select phone_e164, pin_hash, role from users where id = $1", [userId]);
  const u = rows[0];
  if (!u) throw new PinError("invalid_credentials", "Account not found.");
  if (isAdminRole(u.role)) throw new PinError("pin_not_for_staff", "Staff accounts must sign in with an SMS code.");
  if (u.pin_hash && !(await checkPin(currentPin ?? "", u.pin_hash))) throw new PinError("wrong_current_pin", "Current PIN is incorrect.");
  const problem = pinProblem(pin, u.phone_e164);
  if (problem) throw problem;
  await db.query("update users set pin_hash = $2, pin_set_at = now(), pin_failed_count = 0, pin_locked = false, updated_at = now() where id = $1", [userId, await hashPin(pin)]);
  await db.query("insert into audit_events (actor_user_id, action, target_type, target_id) values ($1,'auth.pin_set','user',$2)", [userId, userId]);
}

export async function removePin(userId: string, currentPin: string, db: Db = getDb()): Promise<void> {
  const { rows } = await db.query<{ pin_hash: string | null; pin_locked: boolean }>("select pin_hash, pin_locked from users where id = $1", [userId]);
  if (!rows[0]?.pin_hash) throw new PinError("no_pin", "No PIN is set.");
  // A locked PIN can be removed without it (the user is already signed in).
  if (!rows[0].pin_locked && !(await checkPin(currentPin, rows[0].pin_hash))) throw new PinError("wrong_current_pin", "Current PIN is incorrect.");
  await db.query("update users set pin_hash = null, pin_set_at = null, pin_failed_count = 0, pin_locked = false, updated_at = now() where id = $1", [userId]);
  await db.query("insert into audit_events (actor_user_id, action, target_type, target_id) values ($1,'auth.pin_removed','user',$2)", [userId, userId]);
}

const GENERIC = "Mobile number or PIN is incorrect. You can always sign in with an SMS code.";

/** Sign in with mobile + PIN. No SMS is sent and no sign-in fee is charged. */
export async function verifyPinLogin(phone: string, pin: string, db: Db = getDb()): Promise<{ userId: string }> {
  const s = await getSetting("pin", db);
  if (!s.enabled) throw new PinError("pin_disabled", "PIN sign-in is turned off. Use an SMS code.");
  const phoneE164 = normalizeNepalPhone(phone);
  if (!phoneE164 || !/^\d{4,6}$/.test(pin)) throw new PinError("invalid_credentials", GENERIC);
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ id: string; pin_hash: string | null; pin_locked: boolean; pin_failed_count: number; role: string; status: string; phone_verified_at: unknown }>(
      "select id, pin_hash, pin_locked, pin_failed_count, role, status, phone_verified_at from users where phone_e164 = $1 for update",
      [phoneE164],
    );
    const u = rows[0];
    const usable = Boolean(u && u.pin_hash && u.status === "active" && u.phone_verified_at && !isAdminRole(u.role));
    const ok = await checkPin(pin, usable ? u!.pin_hash : null);
    if (!u || !usable) throw new PinError("invalid_credentials", GENERIC);
    if (u.pin_locked) throw new PinError("pin_locked", "PIN locked after too many wrong tries. Sign in with an SMS code to unlock it.");
    if (!ok) {
      const failed = u.pin_failed_count + 1;
      const lock = failed >= s.max_attempts;
      await tx.query("update users set pin_failed_count = $2, pin_locked = $3 where id = $1", [u.id, failed, lock]);
      await tx.query("insert into audit_events (actor_user_id, actor_via, action, target_type, target_id, json_detail_redacted) values ($1,'web',$2,'user',$3,$4)", [
        u.id, lock ? "auth.pin_locked" : "auth.pin_failed", u.id, JSON.stringify({ failed }),
      ]);
      // Commit the counter even though the sign-in fails.
      return { userId: "", failed: true, lock } as unknown as { userId: string };
    }
    await tx.query("update users set pin_failed_count = 0, updated_at = now() where id = $1", [u.id]);
    await tx.query("insert into audit_events (actor_user_id, actor_via, action, target_type, target_id) values ($1,'web','auth.pin_login','user',$2)", [u.id, u.id]);
    return { userId: u.id };
  }).then((r) => {
    const x = r as { userId: string; failed?: boolean; lock?: boolean };
    if (x.failed) throw x.lock ? new PinError("pin_locked", "PIN locked after too many wrong tries. Sign in with an SMS code to unlock it.") : new PinError("invalid_credentials", GENERIC);
    return { userId: x.userId };
  });
}
