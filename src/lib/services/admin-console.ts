import { getDb, type Db } from "../db";
import { audit } from "../core/audit";
import { HttpError } from "../core/errors";
import { normalizeNepalPhone } from "../phone";
import { validateTemplateBody } from "../sms/templates";
import type { Role } from "../auth/rbac";
import { CATEGORIES, TEMPLATE_GROUPS } from "../categories";

const actorP = (id: string) => ({ userId: id, via: "web" as const, scopes: [], locale: "en" });

// ---------------------------------------------------------------------------
// Overview KPIs
// ---------------------------------------------------------------------------
export interface Overview {
  users: { total: number; verified: number; admins: number };
  reminders: { active: number; paused: number };
  sms: { submitted: number; delivered: number; failed: number; pending: number; unknown: number };
  credits: { purchased: number; outstanding: number; reserved: number; spent: number };
  revenue: { gatewayPaisa: number; manualPaisa: number };
  topups: { pendingManual: number; awaitingPayment: number };
}

export async function getOverview(db: Db = getDb()): Promise<Overview> {
  const { rows } = await db.query<Record<string, string>>(`
    select
      (select count(*) from users)::text as users_total,
      (select count(*) from users where phone_verified_at is not null)::text as users_verified,
      (select count(*) from users where role <> 'user')::text as admins,
      (select count(*) from renewal_items where status = 'active')::text as rem_active,
      (select count(*) from renewal_items where status = 'paused')::text as rem_paused,
      (select count(*) from reminder_jobs where status = 'submitted')::text as sms_submitted,
      (select count(*) from reminder_jobs where status = 'delivered')::text as sms_delivered,
      (select count(*) from reminder_jobs where status = 'failed')::text as sms_failed,
      (select count(*) from reminder_jobs where status in ('scheduled','awaiting_credits','sending','planned'))::text as sms_pending,
      (select count(*) from reminder_jobs where status = 'unknown')::text as sms_unknown,
      (select coalesce(sum(signed_credits),0) from wallet_ledger where type = 'topup')::text as purchased,
      (select coalesce(-sum(signed_credits),0) from wallet_ledger where type = 'debit')::text as spent,
      (select coalesce(sum(posted_balance_credits),0) from wallets)::text as outstanding,
      (select coalesce(sum(reserved_credits),0) from wallets)::text as reserved,
      (select coalesce(sum(amount_paisa),0) from payment_orders where status = 'paid')::text as rev_gateway,
      (select coalesce(sum(amount_paisa),0) from manual_topup_requests where status = 'approved')::text as rev_manual,
      (select count(*) from manual_topup_requests where status = 'pending')::text as topups_pending,
      (select count(*) from manual_topup_requests where status = 'awaiting_payment')::text as topups_awaiting
  `);
  const r = rows[0];
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    users: { total: n("users_total"), verified: n("users_verified"), admins: n("admins") },
    reminders: { active: n("rem_active"), paused: n("rem_paused") },
    sms: { submitted: n("sms_submitted"), delivered: n("sms_delivered"), failed: n("sms_failed"), pending: n("sms_pending"), unknown: n("sms_unknown") },
    credits: { purchased: n("purchased"), outstanding: n("outstanding"), reserved: n("reserved"), spent: n("spent") },
    revenue: { gatewayPaisa: n("rev_gateway"), manualPaisa: n("rev_manual") },
    topups: { pendingManual: n("topups_pending"), awaitingPayment: n("topups_awaiting") },
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
export interface UserRow {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  role: Role;
  status: string;
  createdAt: string;
  available: number;
  reserved: number;
  activeReminders: number;
}

export async function searchUsers(q: string, limit = 50, db: Db = getDb()): Promise<UserRow[]> {
  const term = q.trim();
  const phone = normalizeNepalPhone(term);
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`).toLowerCase()}%`;
  const { rows } = await db.query<{
    id: string; phone_e164: string; display_name: string | null; email: string | null; role: Role; status: string; created_at: string;
    posted: string | null; reserved: string | null; active: string;
  }>(
    `select u.id, u.phone_e164, u.display_name, u.email, u.role, u.status, u.created_at,
            w.posted_balance_credits::text as posted, w.reserved_credits::text as reserved,
            (select count(*) from renewal_items r where r.owner_user_id = u.id and r.status = 'active')::text as active
       from users u left join wallets w on w.user_id = u.id
      where $1 = '' or u.phone_e164 = $2 or u.phone_e164 like $3 or lower(coalesce(u.display_name,'')) like $3 or lower(coalesce(u.email,'')) like $3
      order by u.created_at desc limit $4`,
    [term, phone ?? "", like, limit],
  );
  return rows.map((r) => ({
    id: r.id, phone: r.phone_e164, name: r.display_name, email: r.email, role: r.role, status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    available: Number(r.posted ?? 0) - Number(r.reserved ?? 0), reserved: Number(r.reserved ?? 0), activeReminders: Number(r.active),
  }));
}

export async function getUserDetail(userId: string, db: Db = getDb()) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const [user] = await searchUsersById(userId, db);
  if (!user) return null;
  const [ledger, reminders, topups, sms] = await Promise.all([
    db.query<{ id: string; type: string; signed_credits: string; reference_type: string | null; memo: string | null; created_at: string }>(
      "select id::text, type, signed_credits::text, reference_type, memo, created_at from wallet_ledger where user_id = $1 order by created_at desc, id desc limit 100", [userId]),
    db.query<{ id: string; label: string; category: string; expiry_at_utc: string; status: string }>(
      "select id, label, category, expiry_at_utc, status from renewal_items where owner_user_id = $1 and status <> 'deleted' order by expiry_at_utc limit 100", [userId]),
    db.query<{ id: string; reference: string; amount_paisa: string; status: string; created_at: string }>(
      "select id, reference, amount_paisa::text, status, created_at from manual_topup_requests where user_id = $1 order by created_at desc limit 50", [userId]),
    db.query<{ id: string; status: string; due_at_utc: string; label: string; attempts: number; last_error: string | null }>(
      `select j.id, j.status, j.due_at_utc, i.label, j.attempts, j.last_error from reminder_jobs j join renewal_items i on i.id = j.renewal_id
        where j.user_id = $1 order by j.due_at_utc desc limit 100`, [userId]),
  ]);
  return {
    user,
    ledger: ledger.rows.map((l) => ({ id: l.id, type: l.type, credits: Number(l.signed_credits), referenceType: l.reference_type, memo: l.memo, createdAt: new Date(l.created_at).toISOString() })),
    reminders: reminders.rows.map((r) => ({ id: r.id, label: r.label, category: r.category, expiryAtUtc: new Date(r.expiry_at_utc).toISOString(), status: r.status })),
    topups: topups.rows.map((t) => ({ id: t.id, reference: t.reference, amountNpr: Number(t.amount_paisa) / 100, status: t.status, createdAt: new Date(t.created_at).toISOString() })),
    sms: sms.rows.map((s) => ({ id: s.id, status: s.status, dueAtUtc: new Date(s.due_at_utc).toISOString(), label: s.label, attempts: s.attempts, lastError: s.last_error })),
  };
}

async function searchUsersById(userId: string, db: Db): Promise<UserRow[]> {
  const { rows } = await db.query<{ id: string; phone_e164: string; display_name: string | null; email: string | null; role: Role; status: string; created_at: string; posted: string | null; reserved: string | null; active: string }>(
    `select u.id, u.phone_e164, u.display_name, u.email, u.role, u.status, u.created_at, w.posted_balance_credits::text as posted, w.reserved_credits::text as reserved,
            (select count(*) from renewal_items r where r.owner_user_id = u.id and r.status = 'active')::text as active
       from users u left join wallets w on w.user_id = u.id where u.id = $1`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id, phone: r.phone_e164, name: r.display_name, email: r.email, role: r.role, status: r.status, createdAt: new Date(r.created_at).toISOString(),
    available: Number(r.posted ?? 0) - Number(r.reserved ?? 0), reserved: Number(r.reserved ?? 0), activeReminders: Number(r.active),
  }));
}

/** Super Admin only (enforced by the caller's permission check AND here). Cannot change own role or demote the last super_admin. */
export async function setUserRole(actor: { id: string; role: Role }, userId: string, role: Role, db: Db = getDb()): Promise<void> {
  if (actor.role !== "super_admin") throw new HttpError(403, "Only a Super Admin can change roles", "forbidden");
  if (actor.id === userId) throw new HttpError(400, "You cannot change your own role", "self_role_change");
  await db.tx(async (tx) => {
    const { rows } = await tx.query<{ role: Role; status: string }>("select role, status from users where id = $1 for update", [userId]);
    if (!rows[0]) throw new HttpError(404, "User not found", "not_found");
    if (rows[0].role === "super_admin" && role !== "super_admin") {
      const { rows: c } = await tx.query<{ n: string }>("select count(*)::text as n from users where role = 'super_admin' and status = 'active'");
      if (Number(c[0].n) <= 1) throw new HttpError(400, "Cannot demote the last Super Admin", "last_super_admin");
    }
    if (role !== "user" && rows[0].status !== "active") throw new HttpError(400, "Only active users can be admins", "inactive_user");
    await tx.query("update users set role = $2, updated_at = now() where id = $1", [userId, role]);
    await audit(tx, actorP(actor.id), "rbac.role_changed", { type: "user", id: userId }, { from: rows[0].role, to: role });
  });
}

export async function directAdjustment(actorId: string, userId: string, signedCredits: number, reason: string, idempotencyKey: string, db: Db = getDb()): Promise<string> {
  if (!Number.isInteger(signedCredits) || signedCredits === 0) throw new HttpError(400, "Enter a non-zero whole number of credits", "invalid_amount");
  if (Math.abs(signedCredits) > 100000) throw new HttpError(400, "Adjustment too large", "invalid_amount");
  try {
    return await db.tx(async (tx) => {
      const { rows } = await tx.query<{ wallet_direct_adjustment: string }>("select wallet_direct_adjustment($1,$2,$3,$4,$5)", [userId, actorId, signedCredits, reason, idempotencyKey]);
      return rows[0].wallet_direct_adjustment;
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (/only|required|exceed|cannot|non-zero/.test(msg)) throw new HttpError(400, msg, "adjustment_refused");
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Audit and SMS logs
// ---------------------------------------------------------------------------
export async function listAudit(filter: { action?: string; limit?: number } = {}, db: Db = getDb()) {
  const { rows } = await db.query<{ id: string; action: string; actor_via: string; actor_phone: string | null; actor_client_id: string | null; target_type: string | null; target_id: string | null; json_detail_redacted: unknown; created_at: string }>(
    `select a.id::text, a.action, a.actor_via, u.phone_e164 as actor_phone, a.actor_client_id, a.target_type, a.target_id, a.json_detail_redacted, a.created_at
       from audit_events a left join users u on u.id = a.actor_user_id
      where ($1::text is null or a.action like $1 || '%') and a.action <> 'worker.heartbeat'
      order by a.id desc limit $2`,
    [filter.action || null, Math.min(filter.limit ?? 200, 500)],
  );
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
}

export async function listSmsLog(status: string | null, limit = 200, db: Db = getDb()) {
  const { rows } = await db.query<{ attempt_id: string; job_id: string; status: string; api_state: string; provider: string; provider_message_id: string | null; reported_status: string | null; reported_units: number | null; error_text: string | null; request_at: string; phone_e164: string; label: string }>(
    `select a.id as attempt_id, j.id as job_id, j.status, a.api_state, a.provider, a.provider_message_id, a.reported_status, a.reported_units, a.error_text, a.request_at, u.phone_e164, i.label
       from sms_attempts a join reminder_jobs j on j.id = a.job_id join users u on u.id = j.user_id join renewal_items i on i.id = j.renewal_id
      where ($1::text is null or j.status = $1)
      order by a.request_at desc limit $2`,
    [status, limit],
  );
  return rows.map((r) => ({ ...r, request_at: new Date(r.request_at).toISOString() }));
}

// ---------------------------------------------------------------------------
// SMS templates (GSM-7, single segment) and pricing
// ---------------------------------------------------------------------------
export async function listSmsTemplates(db: Db = getDb()) {
  const { rows } = await db.query<{ id: number; locale: string; category: string; template_version: number; body: string; active: boolean }>(
    "select id, locale, category, template_version, body, active from sms_templates order by active desc, locale, category, template_version desc",
  );
  return rows;
}

export async function saveSmsTemplate(actorId: string, locale: "en-NP" | "ne-NP", category: "default" | "today", body: string, db: Db = getDb()) {
  const v = validateTemplateBody(body, category);
  if (!v.ok) throw new HttpError(400, v.error, "invalid_template");
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ v: number }>("select coalesce(max(template_version),0) + 1 as v from sms_templates where locale = $1 and category = $2", [locale, category]);
    await tx.query("update sms_templates set active = false where locale = $1 and category = $2", [locale, category]);
    await tx.query("insert into sms_templates (locale, category, template_version, body, active) values ($1,$2,$3,$4,true)", [locale, category, rows[0].v, body]);
    await audit(tx, actorP(actorId), "sms.template_saved", { type: "sms_template", id: `${locale}/${category}/v${rows[0].v}` }, { body, worstCaseSeptets: v.worstCaseSeptets });
    return { version: rows[0].v, worstCaseSeptets: v.worstCaseSeptets };
  });
}

// ---------------------------------------------------------------------------
// Document templates
// ---------------------------------------------------------------------------
export interface DocTemplate {
  slug: string;
  group_key: string;
  category: string;
  name_en: string;
  name_ne: string;
  sms_label: string;
  description_en: string;
  description_ne: string;
  default_offsets: number[];
  popular: boolean;
  active: boolean;
  sort_order: number;
}

export async function listDocTemplates(includeInactive = false, db: Db = getDb()): Promise<DocTemplate[]> {
  const { rows } = await db.query<DocTemplate>(
    `select slug, group_key, category, name_en, name_ne, sms_label, description_en, description_ne, default_offsets, popular, active, sort_order
       from document_templates where $1 or active order by sort_order, name_en`,
    [includeInactive],
  );
  return rows.map((r) => ({ ...r, default_offsets: (r.default_offsets ?? []).map(Number) }));
}

export async function saveDocTemplate(actorId: string, t: DocTemplate, db: Db = getDb()) {
  if (!/^[a-z0-9-]{2,60}$/.test(t.slug)) throw new HttpError(400, "slug: lowercase letters, digits and dashes", "invalid_template");
  if (!(TEMPLATE_GROUPS as readonly string[]).includes(t.group_key)) throw new HttpError(400, "unknown group", "invalid_template");
  if (!(CATEGORIES as readonly string[]).includes(t.category)) throw new HttpError(400, "unknown category", "invalid_template");
  if (!/^[A-Za-z0-9 ./()&-]{1,30}$/.test(t.sms_label)) throw new HttpError(400, "SMS label: English letters/digits, max 30", "invalid_template");
  if (!t.default_offsets.length || t.default_offsets.length > 10 || t.default_offsets.some((o) => !Number.isInteger(o) || o < 0 || o > 1051200)) {
    throw new HttpError(400, "offsets: 1-10 whole minutes", "invalid_template");
  }
  await db.query(
    `insert into document_templates (slug, group_key, category, name_en, name_ne, sms_label, description_en, description_ne, default_offsets, popular, active, sort_order, updated_by, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     on conflict (slug) do update set group_key = excluded.group_key, category = excluded.category, name_en = excluded.name_en, name_ne = excluded.name_ne,
       sms_label = excluded.sms_label, description_en = excluded.description_en, description_ne = excluded.description_ne, default_offsets = excluded.default_offsets,
       popular = excluded.popular, active = excluded.active, sort_order = excluded.sort_order, updated_by = excluded.updated_by, updated_at = now()`,
    [t.slug, t.group_key, t.category, t.name_en.trim(), t.name_ne.trim(), t.sms_label.trim(), t.description_en.trim(), t.description_ne.trim(), t.default_offsets, t.popular, t.active, t.sort_order, actorId],
  );
  await audit(db, actorP(actorId), "templates.saved", { type: "document_template", id: t.slug }, { active: t.active });
}
