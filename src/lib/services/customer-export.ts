import { getDb, type Db } from "../db";

/**
 * Customer list as CSV for the super admin (permission customers.export).
 * Contains personal data (phone numbers): every download is audited.
 * Cells are protected against spreadsheet formula injection.
 */
export const CUSTOMER_EXPORT_COLUMNS = [
  "user_id", "phone", "name", "role", "status", "language", "sms_language", "joined_at", "phone_verified_at", "last_sign_in_at",
  "available_credits", "reserved_credits", "paid_topups_npr", "credits_spent", "active_reminders", "total_reminders", "groups",
  "whatsapp_opt_in", "pin_enabled", "referral_code", "referred_by_phone", "referrals_rewarded",
  "email", "email_verified", "plan", "plan_ends_at",
] as const;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Formula injection: a leading = + - @ (or tab/CR) would run as a formula in Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ExportOptions {
  includeStaff?: boolean;
  status?: "active" | "all";
}

export async function exportCustomersCsv(opts: ExportOptions = {}, db: Db = getDb()): Promise<{ csv: string; rows: number }> {
  const where: string[] = [];
  if (!opts.includeStaff) where.push("u.role = 'user'");
  if (opts.status !== "all") where.push("u.status = 'active'");
  const { rows } = await db.query<Record<string, unknown>>(
    `select u.id as user_id, u.phone_e164 as phone, u.display_name as name, u.role, u.status, u.ui_language as language, u.locale as sms_language,
            u.created_at as joined_at, u.phone_verified_at,
            (select max(a.created_at) from audit_events a where a.actor_user_id = u.id and a.action in ('auth.otp_verified','auth.pin_login')) as last_sign_in_at,
            coalesce(w.posted_balance_credits - w.reserved_credits, 0) as available_credits, coalesce(w.reserved_credits, 0) as reserved_credits,
            (select coalesce(sum(l.signed_credits),0) from wallet_ledger l where l.user_id = u.id and l.type = 'topup') as paid_topups_npr,
            (select coalesce(-sum(l.signed_credits),0) from wallet_ledger l where l.user_id = u.id and l.type in ('debit','fee')) as credits_spent,
            (select count(*) from renewal_items i where i.owner_user_id = u.id and i.status = 'active') as active_reminders,
            (select count(*) from renewal_items i where i.owner_user_id = u.id and i.status <> 'deleted') as total_reminders,
            (select count(*) from reminder_groups g where g.owner_user_id = u.id) as groups,
            (u.whatsapp_opt_in_at is not null) as whatsapp_opt_in, (u.pin_hash is not null) as pin_enabled,
            u.referral_code, r.phone_e164 as referred_by_phone,
            (select count(*) from referral_rewards rr where rr.referrer_id = u.id and rr.status = 'rewarded') as referrals_rewarded,
            u.email, (u.email_verified_at is not null) as email_verified,
            coalesce((select p.kind from user_plans p where p.user_id = u.id and p.status = 'active' and p.starts_at <= now() and p.ends_at > now() order by p.ends_at desc limit 1), 'basic') as plan,
            (select max(p.ends_at) from user_plans p where p.user_id = u.id and p.status = 'active' and p.ends_at > now()) as plan_ends_at
       from users u
       left join wallets w on w.user_id = u.id
       left join users r on r.id = u.referred_by
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by u.created_at`,
  );
  const lines = [CUSTOMER_EXPORT_COLUMNS.join(",")];
  for (const r of rows) lines.push(CUSTOMER_EXPORT_COLUMNS.map((c) => csvCell(r[c])).join(","));
  // UTF-8 BOM so Excel shows Nepali names correctly.
  return { csv: "﻿" + lines.join("\r\n") + "\r\n", rows: rows.length };
}
