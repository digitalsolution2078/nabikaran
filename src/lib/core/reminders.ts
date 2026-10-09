import { z } from "zod";
import { getDb, type Db } from "../db";
import { bsToAd, parseBsInput } from "../bs-date";
import { kathmanduToUtc, parseIsoDate, DEFAULT_LOCAL_TIME, parseLocalTime } from "../time";
import { planReminders, MAX_OFFSET_MINUTES, type Candidate } from "../scheduler";
import { renderReminder, type TemplateRow } from "../sms/templates";
import { getActivePricing, readWallet } from "./wallet";
import { HttpError } from "./errors";
import { requireScope, type Principal } from "./principal";
import { audit } from "./audit";
import { withIdempotency } from "./idempotency";
import { instantDTO, type ReminderDTO, type ReminderJobDTO, type SchedulePreview, type Warning } from "./dto";

import { CATEGORIES, categorySmsName } from "../categories";
export { CATEGORIES };

export const reminderInputSchema = z.object({
  category: z.enum(CATEGORIES),
  label: z.string().trim().min(1).max(80),
  calendar: z.enum(["AD", "BS"]).default("AD"),
  /** YYYY-MM-DD in the chosen calendar. */
  expiryDate: z.string().trim().min(8).max(12),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default(DEFAULT_LOCAL_TIME),
  notes: z.string().max(500).optional().nullable(),
  familyMemberLabel: z.string().trim().max(60).optional().nullable(),
  templateSlug: z.string().max(60).optional().nullable(),
  offsets: z.array(z.number().int().min(0).max(MAX_OFFSET_MINUTES)).max(20).default([30 * 1440, 7 * 1440, 1440, 0]),
});
export type ReminderInput = z.infer<typeof reminderInputSchema>;
/** @deprecated name kept for the web routes; same schema. */
export const renewalInputSchema = reminderInputSchema;
export type RenewalInput = ReminderInput;

export interface RenewalRow {
  id: string;
  owner_user_id: string;
  category: string;
  label: string;
  expiry_at_utc: string;
  local_time: string;
  date_input_calendar: "AD" | "BS";
  date_input_raw: string | null;
  notes: string | null;
  family_member_label: string | null;
  status: string;
  cycle_no: number;
  created_at: string;
  updated_at: string;
}

export interface JobRow {
  id: string;
  renewal_id: string;
  rule_id: string;
  cycle_no: number;
  due_at_utc: string;
  estimated_segments: number;
  estimated_credits: string | number;
  status: string;
  attempts: number;
  last_error: string | null;
  offset_minutes?: number;
  label?: string;
}

export function resolveExpiry(input: Pick<ReminderInput, "calendar" | "expiryDate" | "localTime">): Date {
  parseLocalTime(input.localTime);
  if (input.calendar === "BS") {
    const bs = parseBsInput(input.expiryDate);
    if (!bs) throw new HttpError(400, "Invalid Bikram Sambat date (YYYY-MM-DD, 2000..2090)", "invalid_bs_date");
    return kathmanduToUtc(bsToAd(bs), input.localTime);
  }
  const ad = parseIsoDate(input.expiryDate);
  if (!ad) throw new HttpError(400, "Invalid date (YYYY-MM-DD)", "invalid_date");
  return kathmanduToUtc(ad, input.localTime);
}

export async function loadTemplates(db: Db): Promise<TemplateRow[]> {
  const { rows } = await db.query<TemplateRow>("select locale, category, body from sms_templates where active order by template_version desc");
  return rows;
}

export function toReminderDTO(r: RenewalRow, jobs: JobRow[]): ReminderDTO {
  return {
    id: r.id,
    label: r.label,
    category: r.category,
    status: r.status as ReminderDTO["status"],
    cycleNo: r.cycle_no,
    expiry: instantDTO(new Date(r.expiry_at_utc)),
    localTime: r.local_time,
    inputCalendar: r.date_input_calendar,
    inputDate: r.date_input_raw,
    notes: r.notes,
    familyMemberLabel: r.family_member_label,
    jobs: jobs
      .filter((j) => j.cycle_no === r.cycle_no)
      .map<ReminderJobDTO>((j) => ({
        id: j.id,
        offsetMinutes: j.offset_minutes ?? 0,
        due: instantDTO(new Date(j.due_at_utc)),
        status: j.status as ReminderJobDTO["status"],
        estimatedSegments: j.estimated_segments,
        estimatedCredits: Number(j.estimated_credits),
        lastError: j.last_error,
      })),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/**
 * Cost preview (FR-05). Side-effect free. Returns machine-readable warnings so
 * both the web form and an AI client can decide whether to ask the user before
 * confirming.
 */
export async function previewSchedule(
  p: Principal,
  input: Pick<ReminderInput, "label" | "calendar" | "expiryDate" | "localTime" | "offsets"> & { category?: string },
  db: Db = getDb(),
  now: Date = new Date(),
): Promise<SchedulePreview> {
  requireScope(p, "reminders:read");
  const expiryAtUtc = resolveExpiry(input);
  const plan = planReminders(expiryAtUtc, input.offsets.map((offsetMinutes) => ({ offsetMinutes })), now);
  const [pricing, templates, wallet] = await Promise.all([getActivePricing(db), loadTemplates(db), readWallet(p.userId, db)]);
  const lines = plan.candidates.map((c) => {
    const r = renderReminder({ label: input.label, fallbackLabel: categorySmsName(input.category ?? "other"), expiryAtUtc, dueAtUtc: c.dueAtUtc, locale: p.locale }, templates);
    return {
      offsetMinutes: c.offsetMinutes,
      due: instantDTO(c.dueAtUtc),
      horizon: c.horizon,
      smsText: r.body,
      segments: r.estimate.segments,
      encoding: r.estimate.encoding,
      credits: r.estimate.segments * pricing.creditsPerUnit,
      smsLabel: r.smsLabel,
      labelAdjusted: r.labelAdjusted,
    };
  });
  const totalCredits = lines.reduce((s, l) => s + l.credits, 0);
  const reservedOnConfirmCredits = lines.filter((l) => l.horizon === "within").reduce((s, l) => s + l.credits, 0);
  const warnings: Warning[] = [];
  if (expiryAtUtc.getTime() <= now.getTime()) warnings.push("expiry_in_past");
  if (plan.droppedPast > 0) warnings.push("some_offsets_in_past");
  if (plan.droppedDuplicate > 0) warnings.push("duplicate_offsets");
  if (plan.droppedOverCap > 0) warnings.push("over_cap");
  if (lines.some((l) => l.horizon === "beyond")) warnings.push("beyond_two_year_horizon");
  if (input.calendar === "BS") warnings.push("bs_date_needs_confirmation");
  if (lines.some((l) => l.labelAdjusted)) warnings.push("sms_label_adjusted");
  const shortfallCredits = Math.max(0, reservedOnConfirmCredits - wallet.available);
  if (shortfallCredits > 0) warnings.push("insufficient_credits");
  return {
    expiry: instantDTO(expiryAtUtc),
    lines,
    totalCredits,
    reservedOnConfirmCredits,
    creditsPerUnit: pricing.creditsPerUnit,
    pricingVersion: pricing.id,
    wallet,
    sufficient: shortfallCredits === 0,
    shortfallCredits,
    warnings,
    dropped: { past: plan.droppedPast, duplicate: plan.droppedDuplicate, overCap: plan.droppedOverCap },
  };
}

export interface MaterializeSummary {
  scheduled: number;
  awaiting: number;
  planned: number;
}

/**
 * Insert jobs for the current cycle and reserve credits (or mark awaiting).
 * Must run inside the caller's transaction.
 */
async function materializeJobs(tx: Db, renewal: RenewalRow, locale: string, candidates: Candidate[]): Promise<MaterializeSummary> {
  const pricing = await getActivePricing(tx);
  const templates = await loadTemplates(tx);
  const expiry = new Date(renewal.expiry_at_utc);
  const result: MaterializeSummary = { scheduled: 0, awaiting: 0, planned: 0 };

  await tx.query("update reminder_rules set enabled = false where renewal_id = $1", [renewal.id]);
  for (const c of candidates) {
    const { rows: ruleRows } = await tx.query<{ id: string }>(
      `insert into reminder_rules (renewal_id, offset_minutes, enabled) values ($1, $2, true)
       on conflict (renewal_id, offset_minutes) do update set enabled = true returning id`,
      [renewal.id, c.offsetMinutes],
    );
    const ruleId = ruleRows[0].id;
    const rendered = renderReminder({ label: renewal.label, fallbackLabel: categorySmsName(renewal.category), expiryAtUtc: expiry, dueAtUtc: c.dueAtUtc, locale }, templates);
    const credits = rendered.estimate.segments * pricing.creditsPerUnit;
    const { rows: jobRows } = await tx.query<{ id: string }>(
      `insert into reminder_jobs (renewal_id, rule_id, user_id, cycle_no, due_at_utc, cost_version, estimated_segments, estimated_credits, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'planned')
       on conflict (renewal_id, rule_id, cycle_no) do update set due_at_utc = excluded.due_at_utc returning id`,
      [renewal.id, ruleId, renewal.owner_user_id, renewal.cycle_no, c.dueAtUtc.toISOString(), pricing.id, rendered.estimate.segments, credits],
    );
    if (c.horizon === "beyond") {
      result.planned++;
      continue;
    }
    const { rows: res } = await tx.query<{ wallet_reserve_for_job: string }>("select wallet_reserve_for_job($1)", [jobRows[0].id]);
    if (res[0].wallet_reserve_for_job === "scheduled") result.scheduled++;
    else result.awaiting++;
  }
  return result;
}

export async function cancelUnsentJobs(tx: Db, renewalId: string, reason: string): Promise<number> {
  const { rows } = await tx.query<{ id: string }>(
    "select id from reminder_jobs where renewal_id = $1 and status in ('planned','awaiting_credits','scheduled') for update",
    [renewalId],
  );
  for (const r of rows) {
    await tx.query("select wallet_release_for_job($1)", [r.id]);
    await tx.query("update reminder_jobs set status = 'cancelled', last_error = $2, updated_at = now() where id = $1", [r.id, reason]);
  }
  return rows.length;
}

export interface MutationResult {
  reminder: ReminderDTO;
  summary: MaterializeSummary & { cancelled?: number };
  replayed: boolean;
}

async function loadDto(tx: Db, renewalId: string): Promise<ReminderDTO> {
  const { rows } = await tx.query<RenewalRow>("select * from renewal_items where id = $1", [renewalId]);
  const { rows: jobs } = await tx.query<JobRow>(
    "select j.*, r.offset_minutes from reminder_jobs j join reminder_rules r on r.id = j.rule_id where j.renewal_id = $1 order by j.due_at_utc",
    [renewalId],
  );
  return toReminderDTO(rows[0], jobs);
}

/** Transaction-scoped create (no idempotency wrapper). Used by createReminder and by prepared-action confirmation. */
export async function createReminderIn(tx: Db, p: Principal, input: ReminderInput, now = new Date(), detail: Record<string, unknown> = {}): Promise<Omit<MutationResult, "replayed">> {
  requireScope(p, "reminders:write");
  const expiryAtUtc = resolveExpiry(input);
  const plan = planReminders(expiryAtUtc, input.offsets.map((offsetMinutes) => ({ offsetMinutes })), now);
  const { rows } = await tx.query<RenewalRow>(
    `insert into renewal_items (owner_user_id, category, label, expiry_at_utc, local_time, date_input_calendar, date_input_raw, notes, family_member_label, template_slug)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,(select slug from document_templates where slug = $10)) returning *`,
    [p.userId, input.category, input.label, expiryAtUtc.toISOString(), input.localTime, input.calendar, input.expiryDate, input.notes ?? null, input.familyMemberLabel ?? null, input.templateSlug ?? null],
  );
  const renewal = rows[0];
  const summary = await materializeJobs(tx, renewal, p.locale, plan.candidates);
  await audit(tx, p, "reminder.create", { type: "renewal", id: renewal.id }, { ...summary, ...detail });
  return { reminder: await loadDto(tx, renewal.id), summary };
}

/** Create a renewal and its reminder plan; reserves credits per job (never overdrafts). */
export async function createReminder(
  p: Principal,
  input: ReminderInput,
  opts: { idempotencyKey?: string | null } = {},
  db: Db = getDb(),
  now = new Date(),
): Promise<MutationResult> {
  requireScope(p, "reminders:write");
  resolveExpiry(input);
  return db.tx(async (tx) => {
    const { result, replayed } = await withIdempotency(tx, p.userId, opts.idempotencyKey, "create_reminder", () =>
      createReminderIn(tx, p, input, now, { idempotencyKey: opts.idempotencyKey ?? null }),
    );
    return { ...result, replayed };
  });
}

/** Transaction-scoped full edit (no idempotency wrapper). */
export async function updateReminderIn(tx: Db, p: Principal, renewalId: string, input: ReminderInput, now = new Date(), detail: Record<string, unknown> = {}): Promise<Omit<MutationResult, "replayed">> {
  requireScope(p, "reminders:write");
  const expiryAtUtc = resolveExpiry(input);
  const plan = planReminders(expiryAtUtc, input.offsets.map((offsetMinutes) => ({ offsetMinutes })), now);
  const { rows: existing } = await tx.query<RenewalRow>(
    "select * from renewal_items where id = $1 and owner_user_id = $2 and status <> 'deleted' for update",
    [renewalId, p.userId],
  );
  if (!existing[0]) throw new HttpError(404, "Reminder not found", "not_found");
  const cancelled = await cancelUnsentJobs(tx, renewalId, "superseded by edit");
  const { rows } = await tx.query<RenewalRow>(
    `update renewal_items set category=$3, label=$4, expiry_at_utc=$5, local_time=$6, date_input_calendar=$7, date_input_raw=$8, notes=$9,
       family_member_label=$10, status='active', cycle_no = cycle_no + 1, updated_at = now()
     where id = $1 and owner_user_id = $2 returning *`,
    [renewalId, p.userId, input.category, input.label, expiryAtUtc.toISOString(), input.localTime, input.calendar, input.expiryDate, input.notes ?? null, input.familyMemberLabel ?? null],
  );
  const renewal = rows[0];
  const summary = { ...(await materializeJobs(tx, renewal, p.locale, plan.candidates)), cancelled };
  await audit(tx, p, "reminder.update", { type: "renewal", id: renewal.id }, { ...summary, ...detail });
  return { reminder: await loadDto(tx, renewal.id), summary };
}

/** Full edit: starts a new cycle, cancels unsent jobs (releasing holds) and re-plans. */
export async function updateReminder(
  p: Principal,
  renewalId: string,
  input: ReminderInput,
  opts: { idempotencyKey?: string | null } = {},
  db: Db = getDb(),
  now = new Date(),
): Promise<MutationResult> {
  requireScope(p, "reminders:write");
  resolveExpiry(input);
  return db.tx(async (tx) => {
    const { result, replayed } = await withIdempotency(tx, p.userId, opts.idempotencyKey, "update_reminder", () =>
      updateReminderIn(tx, p, renewalId, input, now, { idempotencyKey: opts.idempotencyKey ?? null }),
    );
    return { ...result, replayed };
  });
}

export type StatusAction = "pause" | "resume" | "cancel" | "delete";

export async function setReminderStatus(
  p: Principal,
  renewalId: string,
  action: StatusAction,
  opts: { idempotencyKey?: string | null } = {},
  db: Db = getDb(),
): Promise<{ reminder: ReminderDTO | null; cancelled: number; resumed: number; replayed: boolean }> {
  requireScope(p, "reminders:write");
  return db.tx(async (tx) => {
    const { result, replayed } = await withIdempotency(tx, p.userId, opts.idempotencyKey, `reminder.${action}`, async () => {
      const { rows } = await tx.query<RenewalRow>(
        "select * from renewal_items where id = $1 and owner_user_id = $2 and status <> 'deleted' for update",
        [renewalId, p.userId],
      );
      const r = rows[0];
      if (!r) throw new HttpError(404, "Reminder not found", "not_found");
      let cancelled = 0;
      let resumed = 0;
      if (action === "resume") {
        await tx.query("update renewal_items set status = 'active', updated_at = now() where id = $1", [renewalId]);
        const { rows: jobs } = await tx.query<{ id: string }>(
          "select id from reminder_jobs where renewal_id = $1 and cycle_no = $2 and status = 'cancelled' and last_error = 'paused' and due_at_utc > now()",
          [renewalId, r.cycle_no],
        );
        for (const j of jobs) {
          await tx.query("update reminder_jobs set status = 'planned', last_error = null, updated_at = now() where id = $1", [j.id]);
          await tx.query("select wallet_reserve_for_job($1)", [j.id]);
        }
        resumed = jobs.length;
      } else {
        const status = action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "deleted";
        cancelled = await cancelUnsentJobs(tx, renewalId, action === "pause" ? "paused" : status);
        await tx.query("update renewal_items set status = $2, updated_at = now() where id = $1", [renewalId, status]);
      }
      await audit(tx, p, `reminder.${action}`, { type: "renewal", id: renewalId }, { cancelled, resumed });
      return { reminder: action === "delete" ? null : await loadDto(tx, renewalId), cancelled, resumed };
    });
    return { ...result, replayed };
  });
}

export interface ListFilter {
  status?: "active" | "paused" | "cancelled" | "all";
  category?: string;
  limit?: number;
  cursor?: string | null;
}

export async function listReminders(p: Principal, filter: ListFilter = {}, db: Db = getDb()): Promise<{ reminders: ReminderDTO[]; nextCursor: string | null }> {
  requireScope(p, "reminders:read");
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 50);
  const params: unknown[] = [p.userId, limit + 1];
  let where = "owner_user_id = $1 and status <> 'deleted'";
  if (filter.status && filter.status !== "all") {
    params.push(filter.status);
    where += ` and status = $${params.length}`;
  }
  if (filter.category) {
    params.push(filter.category);
    where += ` and category = $${params.length}`;
  }
  if (filter.cursor) {
    const [ts, id] = Buffer.from(filter.cursor, "base64url").toString().split("|");
    if (!ts || !id) throw new HttpError(400, "Invalid cursor", "invalid_cursor");
    params.push(ts, id);
    where += ` and (expiry_at_utc, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  const { rows } = await db.query<RenewalRow>(`select * from renewal_items where ${where} order by expiry_at_utc asc, id asc limit $2`, params);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? Buffer.from(`${new Date(last.expiry_at_utc).toISOString()}|${last.id}`).toString("base64url") : null;
  if (page.length === 0) return { reminders: [], nextCursor: null };
  const { rows: jobs } = await db.query<JobRow>(
    `select j.*, r.offset_minutes from reminder_jobs j join reminder_rules r on r.id = j.rule_id
      where j.renewal_id = any($1::uuid[]) order by j.due_at_utc`,
    [page.map((r) => r.id)],
  );
  return { reminders: page.map((r) => toReminderDTO(r, jobs.filter((j) => j.renewal_id === r.id))), nextCursor };
}

export async function getReminder(p: Principal, renewalId: string, db: Db = getDb()): Promise<ReminderDTO | null> {
  requireScope(p, "reminders:read");
  if (!/^[0-9a-f-]{36}$/i.test(renewalId)) return null;
  const { rows } = await db.query<RenewalRow>("select * from renewal_items where id = $1 and owner_user_id = $2 and status <> 'deleted'", [renewalId, p.userId]);
  if (!rows[0]) return null;
  const { rows: jobs } = await db.query<JobRow>(
    "select j.*, r.offset_minutes from reminder_jobs j join reminder_rules r on r.id = j.rule_id where j.renewal_id = $1 order by j.due_at_utc",
    [renewalId],
  );
  return toReminderDTO(rows[0], jobs);
}

/** Flat job history for dashboards (web only). */
export async function listJobsForUser(p: Principal, limit = 100, db: Db = getDb()): Promise<JobRow[]> {
  requireScope(p, "reminders:read");
  const { rows } = await db.query<JobRow>(
    `select j.*, r.offset_minutes, i.label from reminder_jobs j
       join reminder_rules r on r.id = j.rule_id
       join renewal_items i on i.id = j.renewal_id
      where j.user_id = $1 and j.status <> 'cancelled' order by j.due_at_utc desc limit $2`,
    [p.userId, limit],
  );
  return rows;
}
