import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getDb, type Db } from "../db";
import { env } from "../env";
import { HttpError } from "../core/errors";
import { audit } from "../core/audit";
import { getEmailProvider, textToHtml } from "../providers/email";
import { isPro, requirePro } from "./plans";

/**
 * Pro: add a verified email, and sign in with an emailed 6-digit code.
 *  - codes are stored as salted hashes, expire in 10 minutes, 5 tries each
 *  - sign-in requests always answer the same way, whether or not the email
 *    belongs to an account (no account discovery)
 *  - only Pro accounts with a verified email can sign in by email; staff
 *    accounts always use the SMS code
 *  - the phone number stays the account's main identity: when Pro ends, phone
 *    sign-in still works
 */
const CODE_TTL_MIN = 10;
const MAX_TRIES = 5;

export const emailSchema = z.string().trim().toLowerCase().email().max(120);

const hashCode = (email: string, purpose: string, code: string) =>
  createHash("sha256").update(`${env.otpPepper()}|email|${purpose}|${email}|${code}`).digest("hex");

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function sendCode(db: Db, email: string, purpose: "verify" | "login", userId: string | null): Promise<{ devCode?: string }> {
  const provider = await getEmailProvider(db);
  if (!provider) throw new HttpError(503, "Email is not set up yet. Please try again later.", "email_unavailable");
  const { rows: recent } = await db.query<{ n: number }>(
    "select count(*)::int as n from email_codes where lower(email) = $1 and created_at > now() - interval '15 minutes'",
    [email],
  );
  if ((recent[0]?.n ?? 0) >= 5) throw new HttpError(429, "Too many codes requested. Try again in 15 minutes.", "rate_limited");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const { rows } = await db.query<{ id: string }>(
    "insert into email_codes (user_id, email, purpose, code_hash, expires_at) values ($1,$2,$3,$4, now() + make_interval(mins => $5)) returning id",
    [userId, email, purpose, hashCode(email, purpose, code), CODE_TTL_MIN],
  );
  const subject = purpose === "login" ? `${code} is your Nabikaran sign-in code` : `${code} is your Nabikaran email code`;
  const text = `${purpose === "login" ? "Your Nabikaran sign-in code" : "Your code to add this email to Nabikaran"}: ${code}\n\nIt expires in ${CODE_TTL_MIN} minutes. Never share this code. If you did not ask for it, ignore this email.`;
  const out = await provider.send({ to: email, subject, text, html: textToHtml(text), idempotencyKey: `code:${rows[0].id}` });
  if (out.kind !== "accepted") throw new HttpError(502, "Could not send the email. Check the address and try again.", "email_send_failed");
  return process.env.NODE_ENV !== "production" ? { devCode: code } : {};
}

async function checkCode(db: Db, email: string, purpose: "verify" | "login", code: string, userId: string | null): Promise<{ id: string; user_id: string | null } | null> {
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ id: string; user_id: string | null; code_hash: string; attempts: number }>(
      `select id, user_id, code_hash, attempts from email_codes
        where lower(email) = $1 and purpose = $2 and consumed_at is null and expires_at > now() and ($3::uuid is null or user_id = $3)
        order by created_at desc limit 1 for update`,
      [email, purpose, userId],
    );
    const c = rows[0];
    if (!c || c.attempts >= MAX_TRIES) return null;
    if (!/^\d{6}$/.test(code) || !same(c.code_hash, hashCode(email, purpose, code))) {
      await tx.query("update email_codes set attempts = attempts + 1 where id = $1", [c.id]);
      return null;
    }
    await tx.query("update email_codes set consumed_at = now() where id = $1", [c.id]);
    return { id: c.id, user_id: c.user_id };
  });
}

export interface EmailStatus {
  email: string | null;
  verified: boolean;
}

export async function emailStatus(userId: string, db: Db = getDb()): Promise<EmailStatus> {
  const { rows } = await db.query<{ email: string | null; email_verified_at: string | null }>("select email, email_verified_at from users where id = $1", [userId]);
  return { email: rows[0]?.email ?? null, verified: Boolean(rows[0]?.email_verified_at) };
}

/** Pro: send a code to a new address. */
export async function requestEmailVerify(userId: string, rawEmail: string, db: Db = getDb()): Promise<{ devCode?: string }> {
  await requirePro(userId, db);
  const email = emailSchema.parse(rawEmail);
  const { rows } = await db.query("select 1 from users where lower(email) = $1 and id <> $2", [email, userId]);
  if (rows[0]) throw new HttpError(409, "This email cannot be used. Try another address.", "email_unavailable_for_account");
  return sendCode(db, email, "verify", userId);
}

export async function confirmEmailVerify(userId: string, rawEmail: string, code: string, db: Db = getDb()): Promise<EmailStatus> {
  await requirePro(userId, db);
  const email = emailSchema.parse(rawEmail);
  const ok = await checkCode(db, email, "verify", code.trim(), userId);
  if (!ok) throw new HttpError(400, "That code is wrong or expired.", "invalid_code");
  await db.tx(async (tx) => {
    const { rows } = await tx.query("select 1 from users where lower(email) = $1 and id <> $2", [email, userId]);
    if (rows[0]) throw new HttpError(409, "This email cannot be used. Try another address.", "email_unavailable_for_account");
    await tx.query("update users set email = $2, email_verified_at = now(), updated_at = now() where id = $1", [userId, email]);
    await audit(tx, { userId, via: "web", scopes: [], locale: "en" }, "email.verified", { type: "user", id: userId }, {});
  });
  return emailStatus(userId, db);
}

export async function removeEmail(userId: string, db: Db = getDb()): Promise<EmailStatus> {
  await db.query("update users set email = null, email_verified_at = null, updated_at = now() where id = $1", [userId]);
  // Email reminders cannot be delivered any more; keep the other channels.
  await audit(db, { userId, via: "web", scopes: [], locale: "en" }, "email.removed", { type: "user", id: userId }, {});
  return emailStatus(userId, db);
}

/** Sign-in step 1. Same answer whether or not the email is a Pro account. */
export async function requestEmailLogin(rawEmail: string, db: Db = getDb()): Promise<{ devCode?: string }> {
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) throw new HttpError(400, "Enter a valid email address.", "invalid_email");
  const email = parsed.data;
  const { rows } = await db.query<{ id: string; role: string; status: string }>(
    "select id, role, status from users where lower(email) = $1 and email_verified_at is not null",
    [email],
  );
  const u = rows[0];
  if (!u || u.status !== "active" || u.role !== "user" || !(await isPro(u.id, db))) return {};
  return sendCode(db, email, "login", u.id);
}

/** Sign-in step 2: returns the user id on success. */
export async function verifyEmailLogin(rawEmail: string, code: string, db: Db = getDb()): Promise<string> {
  const parsed = emailSchema.safeParse(rawEmail);
  const fail = () => new HttpError(401, "That code is wrong or expired.", "invalid_code");
  if (!parsed.success) throw fail();
  const ok = await checkCode(db, parsed.data, "login", code.trim(), null);
  if (!ok?.user_id) throw fail();
  // Still Pro, still active, same email (it may have changed since the code was sent).
  const { rows } = await db.query<{ id: string }>(
    "select id from users where id = $1 and lower(email) = $2 and email_verified_at is not null and status = 'active' and role = 'user'",
    [ok.user_id, parsed.data],
  );
  if (!rows[0] || !(await isPro(rows[0].id, db))) throw fail();
  await audit(db, { userId: rows[0].id, via: "web", scopes: [], locale: "en" }, "auth.email_login", { type: "user", id: rows[0].id }, {});
  return rows[0].id;
}

/** Whether the reminder form may offer email: Pro, a verified email, and email set up by the admin. */
export async function emailReminderAvailable(userId: string, db: Db = getDb()): Promise<boolean> {
  const st = await emailStatus(userId, db);
  if (!st.verified || !(await isPro(userId, db))) return false;
  return (await getEmailProvider(db)) !== null;
}
