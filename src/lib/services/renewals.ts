import { z } from "zod";
import { getDb, type Db } from "../db";
import { bsToAd, parseBsInput } from "../bs-date";
import { kathmanduToUtc, parseIsoDate, DEFAULT_LOCAL_TIME, parseLocalTime } from "../time";
import { planReminders, MAX_OFFSET_MINUTES, type Candidate } from "../scheduler";
import { renderReminder, type TemplateRow } from "../sms/templates";
import { getActivePricing } from "./wallet";
import { HttpError } from "../http";

export const CATEGORIES = ["bluebook", "licence", "passport", "insurance", "warranty", "subscription", "other"] as const;

export const renewalInputSchema = z.object({
  category: z.enum(CATEGORIES),
  label: z.string().trim().min(1).max(80),
  calendar: z.enum(["AD", "BS"]).default("AD"),
  /** YYYY-MM-DD in the chosen calendar. */
  expiryDate: z.string().trim().min(8).max(12),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default(DEFAULT_LOCAL_TIME),
  notes: z.string().max(500).optional().nullable(),
  familyMemberLabel: z.string().trim().max(60).optional().nullable(),
  offsets: z.array(z.number().int().min(0).max(MAX_OFFSET_MINUTES)).max(20).default([30 * 1440, 7 * 1440, 1440, 0]),
});
export type RenewalInput = z.infer<typeof renewalInputSchema>;

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

export function resolveExpiry(input: Pick<RenewalInput, "calendar" | "expiryDate" | "localTime">): Date {
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

export interface PreviewLine {
  offsetMinutes: number;
  dueAtUtc: string;
  horizon: "within" | "beyond";
  body: string;
  segments: number;
  encoding: string;
  credits: number;
}

export interface Preview {
  expiryAtUtc: string;
  lines: PreviewLine[];
  totalCredits: number;
  reservedNowCredits: number;
  creditsPerUnit: number;
  pricingVersion: number;
  dropped: { past: number; duplicate: number; overCap: number };
}

export async function previewSchedule(
  input: Pick<RenewalInput, "label" | "calendar" | "expiryDate" | "localTime" | "offsets">,
  locale: string,
  db: Db = getDb(),
  now: Date = new Date(),
): Promise<Preview> {
  const expiryAtUtc = resolveExpiry(input);
  const plan = planReminders(expiryAtUtc, input.offsets.map((offsetMinutes) => ({ offsetMinutes })), now);
  const pricing = await getActivePricing(db);
  const templates = await loadTemplates(db);
  const lines = plan.candidates.map((c) => {
    const r = renderReminder({ label: input.label, expiryAtUtc, dueAtUtc: c.dueAtUtc, locale }, templates);
    return {
      offsetMinutes: c.offsetMinutes,
      dueAtUtc: c.dueAtUtc.toISOString(),
      horizon: c.horizon,
      body: r.body,
      segments: r.estimate.segments,
      encoding: r.estimate.encoding,
      credits: r.estimate.segments * pricing.creditsPerUnit,
    };
  });
  return {
    expiryAtUtc: expiryAtUtc.toISOString(),
    lines,
    totalCredits: lines.reduce((s, l) => s + l.credits, 0),
    reservedNowCredits: lines.filter((l) => l.horizon === "within").reduce((s, l) => s + l.credits, 0),
    creditsPerUnit: pricing.creditsPerUnit,
    pricingVersion: pricing.id,
    dropped: { past: plan.droppedPast, duplicate: plan.droppedDuplicate, overCap: plan.droppedOverCap },
  };
}

/**
 * Create or replace the reminder plan for a renewal inside one transaction:
 * bump cycle, cancel unsent jobs from the previous cycle (releasing holds),
 * upsert rules, insert jobs and reserve credits (or mark awaiting credits).
 */
async function materializeJobs(tx: Db, renewal: RenewalRow, locale: string, candidates: Candidate[], now: Date) {
  const pricing = await getActivePricing(tx);
  const templates = await loadTemplates(tx);
  const expiry = new Date(renewal.expiry_at_utc);
  const result: { scheduled: number; awaiting: number; planned: number } = { scheduled: 0, awaiting: 0, planned: 0 };

  await tx.query("update reminder_rules set enabled = false where renewal_id = $1", [renewal.id]);
  for (const c of candidates) {
    const { rows: ruleRows } = await tx.query<{ id: string }>(
      `insert into reminder_rules (renewal_id, offset_minutes, enabled) values ($1, $2, true)
       on conflict (renewal_id, offset_minutes) do update set enabled = true returning id`,
      [renewal.id, c.offsetMinutes],
    );
    const ruleId = ruleRows[0].id;
    const rendered = renderReminder({ label: renewal.label, expiryAtUtc: expiry, dueAtUtc: c.dueAtUtc, locale }, templates);
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
  void now;
  return result;
}

export async function cancelUnsentJobs(tx: Db, renewalId: string, reason: string) {
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

export async function createRenewal(userId: string, locale: string, input: RenewalInput, db: Db = getDb(), now = new Date()) {
  const expiryAtUtc = resolveExpiry(input);
  const plan = planReminders(expiryAtUtc, input.offsets.map((offsetMinutes) => ({ offsetMinutes })), now);
  return db.tx(async (tx) => {
    const { rows } = await tx.query<RenewalRow>(
      `insert into renewal_items (owner_user_id, category, label, expiry_at_utc, local_time, date_input_calendar, date_input_raw, notes, family_member_label)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [userId, input.category, input.label, expiryAtUtc.toISOString(), input.localTime, input.calendar, input.expiryDate, input.notes ?? null, input.familyMemberLabel ?? null],
    );
    const renewal = rows[0];
    const summary = await materializeJobs(tx, renewal, locale, plan.candidates, now);
    await tx.query("insert into audit_events (actor_user_id, action, target_type, target_id, json_detail_redacted) values ($1,'renewal.create','renewal',$2,$3)", [
      userId, renewal.id, JSON.stringify(summary),
    ]);
    return { renewal, summary };
  });
}

export async function updateRenewal(userId: string, locale: string, renewalId: string, input: RenewalInput, db: Db = getDb(), now = new Date()) {
  const expiryAtUtc = resolveExpiry(input);
  const plan = planReminders(expiryAtUtc, input.offsets.map((offsetMinutes) => ({ offsetMinutes })), now);
  return db.tx(async (tx) => {
    const { rows: existing } = await tx.query<RenewalRow>("select * from renewal_items where id = $1 and owner_user_id = $2 and status <> 'deleted' for update", [renewalId, userId]);
    if (!existing[0]) throw new HttpError(404, "Renewal not found");
    // Edits start a new cycle; unsent jobs from the old cycle are cancelled and holds released.
    const cancelled = await cancelUnsentJobs(tx, renewalId, "superseded by edit");
    const { rows } = await tx.query<RenewalRow>(
      `update renewal_items set category=$3, label=$4, expiry_at_utc=$5, local_time=$6, date_input_calendar=$7, date_input_raw=$8, notes=$9,
         family_member_label=$10, status='active', cycle_no = cycle_no + 1, updated_at = now()
       where id = $1 and owner_user_id = $2 returning *`,
      [renewalId, userId, input.category, input.label, expiryAtUtc.toISOString(), input.localTime, input.calendar, input.expiryDate, input.notes ?? null, input.familyMemberLabel ?? null],
    );
    const renewal = rows[0];
    const summary = await materializeJobs(tx, renewal, locale, plan.candidates, now);
    await tx.query("insert into audit_events (actor_user_id, action, target_type, target_id, json_detail_redacted) values ($1,'renewal.update','renewal',$2,$3)", [
      userId, renewal.id, JSON.stringify({ ...summary, cancelled }),
    ]);
    return { renewal, summary: { ...summary, cancelled } };
  });
}

export async function setRenewalStatus(userId: string, renewalId: string, status: "paused" | "active" | "cancelled" | "deleted", db: Db = getDb()) {
  return db.tx(async (tx) => {
    const { rows } = await tx.query<RenewalRow>("select * from renewal_items where id = $1 and owner_user_id = $2 and status <> 'deleted' for update", [renewalId, userId]);
    if (!rows[0]) throw new HttpError(404, "Renewal not found");
    if (status === "active") {
      // Resume: re-reserve any paused jobs that are still in the future.
      await tx.query("update renewal_items set status = 'active', updated_at = now() where id = $1", [renewalId]);
      const { rows: jobs } = await tx.query<{ id: string }>(
        "select id from reminder_jobs where renewal_id = $1 and cycle_no = $2 and status = 'cancelled' and last_error = 'paused' and due_at_utc > now()",
        [renewalId, rows[0].cycle_no],
      );
      for (const j of jobs) {
        await tx.query("update reminder_jobs set status = 'planned', last_error = null, updated_at = now() where id = $1", [j.id]);
        await tx.query("select wallet_reserve_for_job($1)", [j.id]);
      }
      return { resumed: jobs.length };
    }
    const cancelled = await cancelUnsentJobs(tx, renewalId, status === "paused" ? "paused" : status);
    await tx.query("update renewal_items set status = $2, updated_at = now() where id = $1", [renewalId, status]);
    await tx.query("insert into audit_events (actor_user_id, action, target_type, target_id) values ($1,$3,'renewal',$2)", [userId, renewalId, `renewal.${status}`]);
    return { cancelled };
  });
}

export async function listRenewals(userId: string, db: Db = getDb()): Promise<RenewalRow[]> {
  const { rows } = await db.query<RenewalRow>(
    "select * from renewal_items where owner_user_id = $1 and status <> 'deleted' order by expiry_at_utc asc",
    [userId],
  );
  return rows;
}

export async function getRenewal(userId: string, renewalId: string, db: Db = getDb()): Promise<{ renewal: RenewalRow; jobs: JobRow[] } | null> {
  const { rows } = await db.query<RenewalRow>("select * from renewal_items where id = $1 and owner_user_id = $2 and status <> 'deleted'", [renewalId, userId]);
  if (!rows[0]) return null;
  const { rows: jobs } = await db.query<JobRow>(
    `select j.*, r.offset_minutes from reminder_jobs j join reminder_rules r on r.id = j.rule_id
      where j.renewal_id = $1 and j.cycle_no = $2 order by j.due_at_utc`,
    [renewalId, rows[0].cycle_no],
  );
  return { renewal: rows[0], jobs };
}

export async function listJobsForUser(userId: string, limit = 100, db: Db = getDb()): Promise<JobRow[]> {
  const { rows } = await db.query<JobRow>(
    `select j.*, r.offset_minutes, i.label from reminder_jobs j
       join reminder_rules r on r.id = j.rule_id
       join renewal_items i on i.id = j.renewal_id
      where j.user_id = $1 and j.status <> 'cancelled' order by j.due_at_utc desc limit $2`,
    [userId, limit],
  );
  return rows;
}
