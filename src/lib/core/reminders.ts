import { z } from "zod";
import { getDb, type Db } from "../db";
import { bsToAd, parseBsInput } from "../bs-date";
import { kathmanduToUtc, parseIsoDate, DEFAULT_LOCAL_TIME, parseLocalTime } from "../time";
import { planReminders, MAX_OFFSET_MINUTES, type Candidate } from "../scheduler";
import { renderReminder, type TemplateRow } from "../sms/templates";
import { renderWhatsApp, type WaTemplateRow } from "../whatsapp/templates";
import { whatsappAvailable } from "../whatsapp/availability";
import { getActivePricing, readWallet, type Channel } from "./wallet";
import { HttpError } from "./errors";
import { requireScope, type Principal } from "./principal";
import { audit } from "./audit";
import { assertNotLocked } from "./account-lock";
import { withIdempotency } from "./idempotency";
import { instantDTO, type ChannelCost, type ReminderDTO, type ReminderJobDTO, type SchedulePreview, type SchedulePreviewLine, type Warning } from "./dto";

import { CATEGORIES, categorySmsName, isOccasion } from "../categories";
import { anchorFromInput, anchorToString, nextOccurrence, parseAnchor, type Anchor } from "../recurrence";
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
  /** Delivery channels: SMS only, WhatsApp only, or both. */
  channels: z.array(z.enum(["sms", "whatsapp"])).min(1).max(2).default(["sms"]).transform((c) => [...new Set(c)] as Channel[]),
  /** Required (true) the first time a user picks WhatsApp: consent to business-initiated WhatsApp messages. */
  whatsappConsent: z.boolean().optional(),
  /** Optional group (e.g. "Birthdays"). Omitted on edit = keep; null = remove from group. */
  groupId: z.string().uuid().nullable().optional(),
  /** Repeat every year on the same day (birthdays, anniversaries, yearly renewals). Omitted on edit = keep. */
  repeatYearly: z.boolean().optional(),
});
/** Channels default to SMS only when omitted (web forms, MCP, older callers). */
export type ReminderInput = Omit<z.infer<typeof reminderInputSchema>, "channels"> & { channels?: Channel[] };
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
  channels?: string[] | null;
  template_slug?: string | null;
  group_id?: string | null;
  repeat_yearly?: boolean;
  repeat_anchor?: string | null;
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
  channel?: string;
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

export interface ResolvedSchedule {
  expiryAtUtc: Date;
  /** Date stored as entered (for a yearly reminder: the upcoming occurrence). */
  raw: string;
  anchor: Anchor | null;
}

/**
 * Like resolveExpiry, but a yearly reminder whose date has passed (e.g. a birth
 * date) moves to its next occurrence. A future date is kept as entered.
 */
export function resolveSchedule(input: Pick<ReminderInput, "calendar" | "expiryDate" | "localTime">, repeatYearly: boolean, now: Date = new Date()): ResolvedSchedule {
  if (!repeatYearly) return { expiryAtUtc: resolveExpiry(input), raw: input.expiryDate.trim(), anchor: null };
  parseLocalTime(input.localTime);
  const anchor = anchorFromInput(input.expiryDate);
  if (!anchor) throw new HttpError(400, "Invalid date (YYYY-MM-DD)", input.calendar === "BS" ? "invalid_bs_date" : "invalid_date");
  const year = Number(input.expiryDate.trim().slice(0, 4));
  const next = nextOccurrence(input.calendar, anchor, input.localTime, now, year);
  if (!next) throw new HttpError(400, "This date cannot repeat yearly in the supported calendar range", input.calendar === "BS" ? "invalid_bs_date" : "invalid_date");
  return { expiryAtUtc: next.utc, raw: next.raw, anchor };
}

async function assertOwnGroup(tx: Db, userId: string, groupId: string | null | undefined): Promise<void> {
  if (!groupId) return;
  const { rows } = await tx.query("select 1 from reminder_groups where id = $1 and owner_user_id = $2", [groupId, userId]);
  if (!rows[0]) throw new HttpError(404, "Group not found", "group_not_found");
}

export async function loadTemplates(db: Db): Promise<TemplateRow[]> {
  const { rows } = await db.query<TemplateRow>("select locale, category, body from sms_templates where active order by template_version desc");
  return rows;
}

export async function loadWaTemplates(db: Db): Promise<WaTemplateRow[]> {
  const { rows } = await db.query<WaTemplateRow>("select locale, category, meta_name, meta_language, body_preview from whatsapp_templates where active order by version desc");
  return rows;
}

export function normalizeChannels(c: string[] | null | undefined): Channel[] {
  const v = (c ?? ["sms"]).filter((x): x is Channel => x === "sms" || x === "whatsapp");
  return v.length ? [...new Set(v)] : ["sms"];
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
    channels: normalizeChannels(r.channels),
    templateSlug: r.template_slug ?? null,
    groupId: r.group_id ?? null,
    repeatYearly: Boolean(r.repeat_yearly),
    jobs: jobs
      .filter((j) => j.cycle_no === r.cycle_no)
      .map<ReminderJobDTO>((j) => ({
        id: j.id,
        channel: (j.channel === "whatsapp" ? "whatsapp" : "sms") as ReminderJobDTO["channel"],
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
  input: Pick<ReminderInput, "label" | "calendar" | "expiryDate" | "localTime" | "offsets"> & { category?: string; renewalId?: string | null; channels?: Channel[]; repeatYearly?: boolean },
  db: Db = getDb(),
  now: Date = new Date(),
): Promise<SchedulePreview> {
  requireScope(p, "reminders:read");
  const channels = normalizeChannels(input.channels);
  // Editing releases the current schedule's holds before reserving the new one.
  let releasable = 0;
  if (input.renewalId) {
    const { rows } = await db.query<{ n: string }>(
      `select coalesce(sum(r.held_credits),0)::text as n from credit_reservations r join reminder_jobs j on j.id = r.reminder_job_id
        join renewal_items i on i.id = j.renewal_id
        where j.renewal_id = $1 and i.owner_user_id = $2 and r.status = 'active' and j.status in ('planned','awaiting_credits','scheduled')`,
      [input.renewalId, p.userId],
    );
    releasable = Number(rows[0].n);
  }
  const { expiryAtUtc } = resolveSchedule(input, Boolean(input.repeatYearly), now);
  const plan = planReminders(expiryAtUtc, input.offsets.map((offsetMinutes) => ({ offsetMinutes })), now);
  const wantsWa = channels.includes("whatsapp");
  const [smsPricing, waPricing, templates, waTemplates, wallet, waOk, consent] = await Promise.all([
    getActivePricing(db, "sms"),
    getActivePricing(db, "whatsapp"),
    loadTemplates(db),
    wantsWa ? loadWaTemplates(db) : Promise.resolve([] as WaTemplateRow[]),
    readWallet(p.userId, db),
    wantsWa ? whatsappAvailable(db) : Promise.resolve(true),
    wantsWa ? db.query<{ at: string | null }>("select whatsapp_opt_in_at as at from users where id = $1", [p.userId]) : Promise.resolve(null),
  ]);
  const fallbackLabel = categorySmsName(input.category ?? "other");
  const lines: SchedulePreviewLine[] = [];
  for (const c of plan.candidates) {
    for (const ch of channels) {
      if (ch === "sms") {
        const r = renderReminder({ label: input.label, fallbackLabel, expiryAtUtc, dueAtUtc: c.dueAtUtc, locale: p.locale, category: input.category }, templates);
        lines.push({
          channel: "sms",
          offsetMinutes: c.offsetMinutes,
          due: instantDTO(c.dueAtUtc),
          horizon: c.horizon,
          smsText: r.body,
          segments: r.estimate.segments,
          encoding: r.estimate.encoding,
          credits: r.estimate.segments * smsPricing.creditsPerUnit,
          smsLabel: r.smsLabel,
          labelAdjusted: r.labelAdjusted,
        });
      } else {
        const w = renderWhatsApp({ label: input.label, fallbackLabel, expiryAtUtc, dueAtUtc: c.dueAtUtc, locale: p.locale }, waTemplates);
        lines.push({
          channel: "whatsapp",
          offsetMinutes: c.offsetMinutes,
          due: instantDTO(c.dueAtUtc),
          horizon: c.horizon,
          smsText: w.preview,
          segments: 1,
          encoding: "WhatsApp template",
          credits: waPricing.creditsPerUnit,
          smsLabel: w.params[0],
          labelAdjusted: false,
          whatsappTemplate: { name: w.templateName, language: w.language, params: w.params },
        });
      }
    }
  }
  const byChannel: Partial<Record<Channel, ChannelCost>> = {};
  for (const ch of channels) {
    const ls = lines.filter((l) => l.channel === ch);
    const pr = ch === "sms" ? smsPricing : waPricing;
    byChannel[ch] = { messages: ls.length, credits: ls.reduce((n, l) => n + l.credits, 0), creditsPerUnit: pr.creditsPerUnit, pricingVersion: pr.id };
  }
  const totalCredits = lines.reduce((n, l) => n + l.credits, 0);
  const reservedOnConfirmCredits = totalCredits; // every message is reserved when the reminder is saved
  const warnings: Warning[] = [];
  if (expiryAtUtc.getTime() <= now.getTime()) warnings.push("expiry_in_past");
  if (plan.droppedPast > 0) warnings.push("some_offsets_in_past");
  if (plan.droppedDuplicate > 0) warnings.push("duplicate_offsets");
  if (plan.droppedOverCap > 0) warnings.push("over_cap");
  if (lines.some((l) => l.horizon === "beyond")) warnings.push("beyond_two_year_horizon");
  if (input.calendar === "BS") warnings.push("bs_date_needs_confirmation");
  if (lines.some((l) => l.labelAdjusted)) warnings.push("sms_label_adjusted");
  if (wantsWa && !waOk) warnings.push("whatsapp_unavailable");
  if (wantsWa && isOccasion(input.category)) warnings.push("whatsapp_not_for_occasions");
  if (wantsWa && consent && !consent.rows[0]?.at) warnings.push("whatsapp_consent_required");
  // A negative balance (sign-in fee debt) is settled first, so it adds to the shortfall.
  const shortfallCredits = Math.max(0, reservedOnConfirmCredits - (wallet.available + releasable));
  if (shortfallCredits > 0) warnings.push("insufficient_credits");
  return {
    expiry: instantDTO(expiryAtUtc),
    lines,
    totalCredits,
    reservedOnConfirmCredits,
    creditsPerUnit: smsPricing.creditsPerUnit,
    pricingVersion: smsPricing.id,
    channels,
    byChannel,
    wallet,
    sufficient: shortfallCredits === 0,
    shortfallCredits,
    warnings,
    dropped: { past: plan.droppedPast, duplicate: plan.droppedDuplicate, overCap: plan.droppedOverCap },
  };
}

/** Channel gate for create/update: WhatsApp must be enabled and the user must have opted in. */
async function prepareChannels(tx: Db, p: Principal, input: ReminderInput): Promise<Channel[]> {
  const channels = normalizeChannels(input.channels);
  if (!channels.includes("whatsapp")) return channels;
  if (isOccasion(input.category)) throw new HttpError(400, "Birthday, anniversary and event reminders are sent by SMS only.", "whatsapp_not_for_occasions");
  if (!(await whatsappAvailable(tx))) throw new HttpError(400, "WhatsApp reminders are not available yet. Choose SMS.", "whatsapp_unavailable");
  const { rows } = await tx.query<{ at: string | null }>("select whatsapp_opt_in_at as at from users where id = $1", [p.userId]);
  if (!rows[0]?.at) {
    if (!input.whatsappConsent) {
      throw new HttpError(400, "Please confirm that Nabikaran may send reminders to your number on WhatsApp.", "whatsapp_consent_required");
    }
    await tx.query("update users set whatsapp_opt_in_at = now() where id = $1", [p.userId]);
    await audit(tx, p, "whatsapp.opt_in", { type: "user", id: p.userId }, {});
  }
  return channels;
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
async function materializeJobs(tx: Db, renewal: RenewalRow, locale: string, candidates: Candidate[], opts: { allowAwaiting?: boolean; keepOffsets?: number[] } = {}): Promise<MaterializeSummary> {
  const channels = normalizeChannels(renewal.channels);
  const [smsPricing, waPricing, templates, waTemplates] = await Promise.all([
    getActivePricing(tx, "sms"),
    getActivePricing(tx, "whatsapp"),
    loadTemplates(tx),
    channels.includes("whatsapp") ? loadWaTemplates(tx) : Promise.resolve([] as WaTemplateRow[]),
  ]);
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
    for (const ch of channels) {
      let segments = 1;
      let credits = waPricing.creditsPerUnit;
      let version = waPricing.id;
      if (ch === "sms") {
        const rendered = renderReminder({ label: renewal.label, fallbackLabel: categorySmsName(renewal.category), expiryAtUtc: expiry, dueAtUtc: c.dueAtUtc, locale, category: renewal.category }, templates);
        segments = rendered.estimate.segments;
        credits = segments * smsPricing.creditsPerUnit;
        version = smsPricing.id;
      } else {
        renderWhatsApp({ label: renewal.label, fallbackLabel: categorySmsName(renewal.category), expiryAtUtc: expiry, dueAtUtc: c.dueAtUtc, locale }, waTemplates);
      }
      const { rows: jobRows } = await tx.query<{ id: string }>(
        `insert into reminder_jobs (renewal_id, rule_id, user_id, cycle_no, channel, due_at_utc, cost_version, estimated_segments, estimated_credits, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'planned')
         on conflict (renewal_id, rule_id, cycle_no, channel) do update set due_at_utc = excluded.due_at_utc returning id`,
        [renewal.id, ruleId, renewal.owner_user_id, renewal.cycle_no, ch, c.dueAtUtc.toISOString(), version, segments, credits],
      );
      // Funding policy: every message of a reminder is paid for (reserved) when the
      // reminder is saved, however far away it is. A reminder the customer relies
      // on must never be silently skipped later for lack of credits.
      const { rows: res } = await tx.query<{ wallet_reserve_for_job: string }>("select wallet_reserve_for_job($1)", [jobRows[0].id]);
      if (res[0].wallet_reserve_for_job === "scheduled") result.scheduled++;
      else result.awaiting++;
      if (ch === "whatsapp") await audit(tx, null, "whatsapp.message.scheduled", { type: "reminder_job", id: jobRows[0].id }, { due: c.dueAtUtc.toISOString(), credits });
    }
  }
  // Yearly reminders keep every chosen offset for next year, even one already past this year.
  for (const off of opts.keepOffsets ?? []) {
    await tx.query(
      `insert into reminder_rules (renewal_id, offset_minutes, enabled) values ($1, $2, true)
       on conflict (renewal_id, offset_minutes) do update set enabled = true`,
      [renewal.id, off],
    );
  }
  if (result.awaiting > 0 && !opts.allowAwaiting) {
    // Abort the whole transaction: no reminder is saved half-funded.
    const need = await tx.query<{ n: string }>(
      "select coalesce(sum(estimated_credits),0)::text as n from reminder_jobs where renewal_id = $1 and cycle_no = $2 and status in ('scheduled','awaiting_credits','planned')",
      [renewal.id, renewal.cycle_no],
    );
    throw insufficientCredits(Number(need.rows[0].n), (await readWallet(renewal.owner_user_id, tx)).available + (await heldFor(tx, renewal.id, renewal.cycle_no)));
  }
  return result;
}

async function heldFor(tx: Db, renewalId: string, cycleNo: number): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    `select coalesce(sum(r.held_credits),0)::text as n from credit_reservations r join reminder_jobs j on j.id = r.reminder_job_id
      where j.renewal_id = $1 and j.cycle_no = $2 and r.status = 'active'`,
    [renewalId, cycleNo],
  );
  return Number(rows[0].n);
}

export function insufficientCredits(needed: number, available: number): HttpError {
  // Debt counts: with -1 available and 12 needed, 13 must be added.
  const shortfall = Math.max(1, needed - available);
  return new HttpError(
    402,
    `Not enough credits: this reminder needs ${needed} credits and you have ${available}. Top up at least ${shortfall} credits — nothing was saved.`,
    "insufficient_credits",
    { neededCredits: needed, availableCredits: available, shortfallCredits: shortfall },
  );
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
  await assertNotLocked(p.userId, tx);
  const repeatYearly = Boolean(input.repeatYearly);
  const sched = resolveSchedule(input, repeatYearly, now);
  const expiryAtUtc = sched.expiryAtUtc;
  const plan = planReminders(expiryAtUtc, input.offsets.map((offsetMinutes) => ({ offsetMinutes })), now);
  const channels = await prepareChannels(tx, p, input);
  await assertOwnGroup(tx, p.userId, input.groupId);
  const { rows } = await tx.query<RenewalRow>(
    `insert into renewal_items (owner_user_id, category, label, expiry_at_utc, local_time, date_input_calendar, date_input_raw, notes, family_member_label, template_slug, channels, group_id, repeat_yearly, repeat_anchor)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,(select slug from document_templates where slug = $10),$11,$12,$13,$14) returning *`,
    [p.userId, input.category, input.label, expiryAtUtc.toISOString(), input.localTime, input.calendar, sched.raw, input.notes ?? null, input.familyMemberLabel ?? null, input.templateSlug ?? null, channels,
      input.groupId ?? null, repeatYearly, sched.anchor ? anchorToString(sched.anchor) : null],
  );
  const renewal = rows[0];
  const summary = await materializeJobs(tx, renewal, p.locale, plan.candidates, { keepOffsets: repeatYearly ? input.offsets : [] });
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
  resolveSchedule(input, Boolean(input.repeatYearly), now);
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
  await assertNotLocked(p.userId, tx);
  const { rows: existing } = await tx.query<RenewalRow>(
    "select * from renewal_items where id = $1 and owner_user_id = $2 and status <> 'deleted' for update",
    [renewalId, p.userId],
  );
  if (!existing[0]) throw new HttpError(404, "Reminder not found", "not_found");
  // Omitted group / yearly flags keep their current values (assistants and older callers do not send them).
  const repeatYearly = input.repeatYearly ?? Boolean(existing[0].repeat_yearly);
  const groupId = input.groupId === undefined ? existing[0].group_id ?? null : input.groupId;
  const sched = resolveSchedule(input, repeatYearly, now);
  const expiryAtUtc = sched.expiryAtUtc;
  const plan = planReminders(expiryAtUtc, input.offsets.map((offsetMinutes) => ({ offsetMinutes })), now);
  const channels = await prepareChannels(tx, p, input);
  await assertOwnGroup(tx, p.userId, groupId);
  const cancelled = await cancelUnsentJobs(tx, renewalId, "superseded by edit");
  const { rows } = await tx.query<RenewalRow>(
    `update renewal_items set category=$3, label=$4, expiry_at_utc=$5, local_time=$6, date_input_calendar=$7, date_input_raw=$8, notes=$9,
       family_member_label=$10, channels=$11, template_slug = coalesce((select slug from document_templates where slug = $12), template_slug),
       group_id=$13, repeat_yearly=$14, repeat_anchor=$15,
       status='active', cycle_no = cycle_no + 1, updated_at = now()
     where id = $1 and owner_user_id = $2 returning *`,
    [renewalId, p.userId, input.category, input.label, expiryAtUtc.toISOString(), input.localTime, input.calendar, sched.raw, input.notes ?? null, input.familyMemberLabel ?? null, channels, input.templateSlug ?? null,
      groupId, repeatYearly, sched.anchor ? anchorToString(sched.anchor) : null],
  );
  const renewal = rows[0];
  const summary = { ...(await materializeJobs(tx, renewal, p.locale, plan.candidates, { keepOffsets: repeatYearly ? input.offsets : [] })), cancelled };
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
  if (input.repeatYearly !== undefined) resolveSchedule(input, input.repeatYearly, now);
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
        await assertNotLocked(p.userId, tx);
        await tx.query("update renewal_items set status = 'active', updated_at = now() where id = $1", [renewalId]);
        const { rows: jobs } = await tx.query<{ id: string }>(
          "select id from reminder_jobs where renewal_id = $1 and cycle_no = $2 and status = 'cancelled' and last_error = 'paused' and due_at_utc > now()",
          [renewalId, r.cycle_no],
        );
        let short = 0;
        for (const j of jobs) {
          await tx.query("update reminder_jobs set status = 'planned', last_error = null, updated_at = now() where id = $1", [j.id]);
          const { rows: res } = await tx.query<{ wallet_reserve_for_job: string }>("select wallet_reserve_for_job($1)", [j.id]);
          if (res[0].wallet_reserve_for_job !== "scheduled") short++;
        }
        if (short > 0) {
          const { rows: need } = await tx.query<{ n: string }>(
            "select coalesce(sum(estimated_credits),0)::text as n from reminder_jobs where id = any($1::uuid[])",
            [jobs.map((j) => j.id)],
          );
          throw insufficientCredits(Number(need[0].n), (await readWallet(p.userId, tx)).available + (await heldFor(tx, renewalId, r.cycle_no)));
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
  // node-postgres returns timestamptz as Date; expose ISO strings like the DTOs do.
  return rows.map((r) => ({ ...r, due_at_utc: new Date(r.due_at_utc).toISOString() }));
}

export interface RolloverSummary {
  rolled: number;
  awaitingCredits: number;
}

/**
 * Yearly reminders: once this year's date has passed and every message of the
 * cycle is finished, move to next year's date and reserve its messages. Runs
 * from the reconciler. If the wallet cannot cover next year's messages they are
 * kept as "awaiting credits" (the dashboard asks the customer to top up, and a
 * top-up schedules them automatically) instead of silently dropping them.
 */
export async function rolloverYearly(db: Db = getDb(), now: Date = new Date(), limit = 200): Promise<RolloverSummary> {
  const out: RolloverSummary = { rolled: 0, awaitingCredits: 0 };
  const { rows: due } = await db.query<{ id: string }>(
    `select i.id from renewal_items i
      where i.repeat_yearly and i.status = 'active' and i.expiry_at_utc < $1
        and not exists (select 1 from reminder_jobs j where j.renewal_id = i.id and j.cycle_no = i.cycle_no and j.status in ('scheduled','sending','unknown'))
      order by i.expiry_at_utc limit $2`,
    [new Date(now.getTime() - 6 * 3600_000).toISOString(), limit],
  );
  for (const d of due) {
    await db.tx(async (tx) => {
      const { rows } = await tx.query<RenewalRow & { locale: string }>(
        `select i.*, u.locale from renewal_items i join users u on u.id = i.owner_user_id
          where i.id = $1 and i.repeat_yearly and i.status = 'active' for update of i skip locked`,
        [d.id],
      );
      const r = rows[0];
      if (!r) return;
      const anchor = parseAnchor(r.repeat_anchor) ?? anchorFromInput(r.date_input_raw ?? "");
      const next = anchor ? nextOccurrence(r.date_input_calendar, anchor, r.local_time, new Date(Math.max(now.getTime(), new Date(r.expiry_at_utc).getTime())), 0) : null;
      if (!next) {
        await tx.query("update renewal_items set repeat_yearly = false, updated_at = now() where id = $1", [r.id]);
        await tx.query("insert into audit_events (actor_via, action, target_type, target_id, json_detail_redacted) values ('worker','reminder.rollover_stopped','renewal',$1,'{}')", [r.id]);
        return;
      }
      // Messages of the finished year that were never funded are closed, not sent late.
      await cancelUnsentJobs(tx, r.id, "missed: year ended without credits");
      const { rows: upd } = await tx.query<RenewalRow>(
        "update renewal_items set expiry_at_utc = $2, date_input_raw = $3, cycle_no = cycle_no + 1, updated_at = now() where id = $1 returning *",
        [r.id, next.utc.toISOString(), next.raw],
      );
      const { rows: offs } = await tx.query<{ offset_minutes: number }>("select offset_minutes from reminder_rules where renewal_id = $1 and enabled", [r.id]);
      const plan = planReminders(next.utc, offs.map((o) => ({ offsetMinutes: o.offset_minutes })), now);
      const summary = await materializeJobs(tx, upd[0], r.locale, plan.candidates, { allowAwaiting: true, keepOffsets: offs.map((o) => o.offset_minutes) });
      await tx.query("insert into audit_events (actor_via, action, target_type, target_id, json_detail_redacted) values ('worker','reminder.rollover','renewal',$1,$2)", [
        r.id, JSON.stringify({ next: next.raw, ...summary }),
      ]);
      out.rolled++;
      if (summary.awaiting > 0) out.awaitingCredits++;
    });
  }
  return out;
}
