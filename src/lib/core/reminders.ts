import { z } from "zod";
import { getDb, type Db } from "../db";
import { adToBs, bsToAd, parseBsInput } from "../bs-date";
import { kathmanduToUtc, parseIsoDate, DEFAULT_LOCAL_TIME, parseLocalTime, utcToKathmandu, pad2 } from "../time";
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
import { anchorFromInput, anchorToString, nextEveryMonths, nextOccurrence, parseAnchor, type Anchor } from "../recurrence";
import { emailConfigured } from "./email-config";
export { CATEGORIES };

export const SUB_CURRENCIES = ["NPR", "USD", "INR", "EUR", "GBP", "AUD"] as const;

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
  channels: z.array(z.enum(["sms", "whatsapp", "email"])).min(1).max(3).default(["sms"]).transform((c) => [...new Set(c)] as Channel[]),
  /** Required (true) the first time a user picks WhatsApp: consent to business-initiated WhatsApp messages. */
  whatsappConsent: z.boolean().optional(),
  /** Optional group (e.g. "Birthdays"). Omitted on edit = keep; null = remove from group. */
  groupId: z.string().uuid().nullable().optional(),
  /** Repeat every year on the same day (birthdays, anniversaries, yearly renewals). Omitted on edit = keep. */
  repeatYearly: z.boolean().optional(),
  /** Repeat every N months (1–11; 12 = repeatYearly). Every plan. Omitted on edit = keep; null = stop. */
  repeatMonths: z.number().int().min(1).max(11).nullable().optional(),
  /** Pro: subscription details. Omitted on edit = keep; null = remove. */
  subscription: z.object({
    amount: z.number().min(0).max(100_000_000).nullable(),
    currency: z.enum(SUB_CURRENCIES).default("NPR"),
    paymentMethod: z.string().trim().max(40).nullable().default(null),
    autoRenew: z.boolean().nullable().default(null),
    /** The date is when a free trial turns into a paid subscription. */
    isTrial: z.boolean().optional(),
    /** Must be cancelled this many days before the renewal date: adds a "cancel by" reminder. */
    cancelNoticeDays: z.number().int().min(0).max(90).nullable().optional(),
  }).nullable().optional(),
  /** Pro: the customer agreed to use wallet credits for messages their included messages do not cover. */
  useCredits: z.boolean().optional(),
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
  repeat_months?: number | null;
  sub_amount?: string | number | null;
  sub_currency?: string | null;
  sub_payment_method?: string | null;
  sub_auto_renew?: boolean | null;
  sub_is_trial?: boolean;
  cancel_notice_days?: number | null;
  linked_to?: string | null;
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
export function resolveSchedule(input: Pick<ReminderInput, "calendar" | "expiryDate" | "localTime">, repeatYearly: boolean, now: Date = new Date(), repeatMonths: number | null = null): ResolvedSchedule {
  if (repeatMonths && !repeatYearly) {
    // Every N months: a past first date (e.g. last month's charge) moves to the next one.
    parseLocalTime(input.localTime);
    const anchor = anchorFromInput(input.expiryDate);
    const next = anchor ? nextEveryMonths(input.calendar, input.expiryDate, input.localTime, repeatMonths, now) : null;
    if (!anchor || !next) throw new HttpError(400, "Invalid date (YYYY-MM-DD)", input.calendar === "BS" ? "invalid_bs_date" : "invalid_date");
    return { expiryAtUtc: next.utc, raw: next.raw, anchor };
  }
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
  const v = (c ?? ["sms"]).filter((x): x is Channel => x === "sms" || x === "whatsapp" || x === "email");
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
    repeatMonths: r.repeat_months ?? null,
    subscription: (r.sub_amount !== null && r.sub_amount !== undefined) || r.sub_payment_method || r.sub_is_trial || (r.cancel_notice_days !== null && r.cancel_notice_days !== undefined) || r.category === "subscription" || r.category === "free_trial"
      ? { amount: r.sub_amount === null || r.sub_amount === undefined ? null : Number(r.sub_amount), currency: r.sub_currency ?? "NPR", paymentMethod: r.sub_payment_method ?? null, autoRenew: r.sub_auto_renew ?? null, isTrial: Boolean(r.sub_is_trial), cancelNoticeDays: r.cancel_notice_days ?? null }
      : null,
    linkedTo: r.linked_to ?? null,
    jobs: jobs
      .filter((j) => j.cycle_no === r.cycle_no)
      .map<ReminderJobDTO>((j) => ({
        id: j.id,
        channel: (j.channel === "whatsapp" || j.channel === "email" ? j.channel : "sms") as ReminderJobDTO["channel"],
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
 * Included messages a paid/grant Pro plan still has (plus, when editing, the
 * ones this reminder holds now and would give back). Null without such a plan.
 */
async function includedLeft(db: Db, userId: string, renewalId: string | null, now: Date): Promise<{ endsAt: Date; left: Record<Channel, number>; granted: Record<Channel, number>; fallback: boolean } | null> {
  const { rows } = await db.query<{ id: string; ends_at: string }>(
    `select id, ends_at from user_plans where user_id = $1 and status = 'active' and kind in ('paid','grant') and starts_at <= $2 and ends_at > $2
      order by ends_at limit 1`,
    [userId, now.toISOString()],
  );
  if (!rows[0]) return null;
  const { rows: a } = await db.query<{ channel: Channel; left: number; granted: number }>(
    "select channel, (granted - reserved - used)::int as left, granted from plan_allowances where user_plan_id = $1",
    [rows[0].id],
  );
  const left: Record<Channel, number> = { sms: 0, whatsapp: 0, email: 0 };
  const granted: Record<Channel, number> = { sms: 0, whatsapp: 0, email: 0 };
  for (const r of a) {
    left[r.channel] = Math.max(0, r.left);
    granted[r.channel] = r.granted;
  }
  const { rows: u } = await db.query<{ f: boolean }>("select pro_credit_fallback as f from users where id = $1", [userId]);
  if (renewalId) {
    const { rows: held } = await db.query<{ channel: Channel; n: number }>(
      `select j.channel, sum(r.allowance_units)::int as n from credit_reservations r join reminder_jobs j on j.id = r.reminder_job_id
        where j.renewal_id = $1 and r.status = 'active' and r.allowance_plan_id = $2 group by j.channel`,
      [renewalId, rows[0].id],
    );
    for (const h of held) left[h.channel] += h.n;
  }
  return { endsAt: new Date(rows[0].ends_at), left, granted, fallback: Boolean(u[0]?.f) };
}

/** End of the Pro plan running now (any kind), or null. */
async function proEnd(db: Db, userId: string, now: Date): Promise<Date | null> {
  const { rows } = await db.query<{ e: string | null }>(
    "select max(ends_at) as e from user_plans where user_id = $1 and status = 'active' and starts_at <= $2 and ends_at > $2",
    [userId, now.toISOString()],
  );
  return rows[0]?.e ? new Date(rows[0].e) : null;
}

/** Email reminders need Pro, a verified email and email set up by the admin. */
async function emailReady(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `select (u.email_verified_at is not null and exists (select 1 from user_plans p where p.user_id = u.id and p.status = 'active' and p.starts_at <= now() and p.ends_at > now())) as ok
       from users u where u.id = $1`,
    [userId],
  );
  return Boolean(rows[0]?.ok) && (await emailConfigured(db));
}

/**
 * Cost preview (FR-05). Side-effect free. Returns machine-readable warnings so
 * both the web form and an AI client can decide whether to ask the user before
 * confirming.
 */
export async function previewSchedule(
  p: Principal,
  input: Pick<ReminderInput, "label" | "calendar" | "expiryDate" | "localTime" | "offsets"> & { category?: string; renewalId?: string | null; channels?: Channel[]; repeatYearly?: boolean; repeatMonths?: number | null },
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
  const { expiryAtUtc } = resolveSchedule(input, Boolean(input.repeatYearly), now, input.repeatMonths ?? null);
  const plan = planReminders(expiryAtUtc, input.offsets.map((offsetMinutes) => ({ offsetMinutes })), now);
  const wantsWa = channels.includes("whatsapp");
  const wantsEmail = channels.includes("email");
  const [smsPricing, waPricing, emailPricing, allowance, emailOk, templates, waTemplates, wallet, waOk, consent] = await Promise.all([
    getActivePricing(db, "sms"),
    getActivePricing(db, "whatsapp"),
    wantsEmail ? getActivePricing(db, "email") : Promise.resolve({ id: 0, creditsPerUnit: 1 }),
    includedLeft(db, p.userId, input.renewalId ?? null, now),
    wantsEmail ? emailReady(db, p.userId) : Promise.resolve(true),
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
      } else if (ch === "email") {
        const r = renderReminder({ label: input.label, fallbackLabel, expiryAtUtc, dueAtUtc: c.dueAtUtc, locale: p.locale, category: input.category }, templates);
        lines.push({
          channel: "email",
          offsetMinutes: c.offsetMinutes,
          due: instantDTO(c.dueAtUtc),
          horizon: c.horizon,
          smsText: r.body,
          segments: 1,
          encoding: "Email",
          credits: emailPricing.creditsPerUnit,
          smsLabel: input.label,
          labelAdjusted: false,
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
  // Pro: messages due before the plan ends use included messages first (no credits).
  if (allowance) {
    const left = { ...allowance.left };
    for (const l of [...lines].sort((a, b) => a.due.utc.localeCompare(b.due.utc))) {
      const units = l.channel === "sms" ? l.segments : 1;
      if (new Date(l.due.utc).getTime() < allowance.endsAt.getTime() && left[l.channel] >= units) {
        left[l.channel] -= units;
        l.included = true;
        l.credits = 0;
      }
    }
  }
  // Pro: credits beyond included messages need the customer's permission (unless they allowed it in Pro settings).
  let permissionCredits = 0;
  if (allowance && !allowance.fallback) {
    for (const l of lines) {
      if (!l.included && allowance.granted[l.channel] > 0 && new Date(l.due.utc).getTime() < allowance.endsAt.getTime()) permissionCredits += l.credits;
    }
  }
  const proEndsAt = await proEnd(db, p.userId, now);
  const byChannel: Partial<Record<Channel, ChannelCost>> = {};
  for (const ch of channels) {
    const ls = lines.filter((l) => l.channel === ch);
    const pr = ch === "sms" ? smsPricing : ch === "email" ? emailPricing : waPricing;
    byChannel[ch] = { messages: ls.length, included: ls.filter((l) => l.included).length, credits: ls.reduce((n, l) => n + l.credits, 0), creditsPerUnit: pr.creditsPerUnit, pricingVersion: pr.id };
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
  if (wantsEmail && !emailOk) warnings.push("email_unavailable");
  if (permissionCredits > 0) warnings.push("credits_permission_required");
  if (proEndsAt && lines.some((l) => new Date(l.due.utc).getTime() >= proEndsAt.getTime())) warnings.push("after_pro_ends");
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
    permissionCredits,
    proEndsAt: proEndsAt ? proEndsAt.toISOString() : null,
    warnings,
    dropped: { past: plan.droppedPast, duplicate: plan.droppedDuplicate, overCap: plan.droppedOverCap },
  };
}

/** Channel gate for create/update: WhatsApp must be enabled and the user must have opted in. */
async function prepareChannels(tx: Db, p: Principal, input: ReminderInput): Promise<Channel[]> {
  const channels = normalizeChannels(input.channels);
  if (channels.includes("email") && !(await emailReady(tx, p.userId))) {
    throw new HttpError(400, "Email reminders need Nabikaran Pro and a verified email (Settings → Email).", "email_unavailable");
  }
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
  const [smsPricing, waPricing, emailPricing, templates, waTemplates] = await Promise.all([
    getActivePricing(tx, "sms"),
    getActivePricing(tx, "whatsapp"),
    channels.includes("email") ? getActivePricing(tx, "email") : Promise.resolve({ id: 0, creditsPerUnit: 1 }),
    loadTemplates(tx),
    channels.includes("whatsapp") ? loadWaTemplates(tx) : Promise.resolve([] as WaTemplateRow[]),
  ]);
  const expiry = new Date(renewal.expiry_at_utc);
  const result: MaterializeSummary = { scheduled: 0, awaiting: 0, planned: 0 };
  let needsPermission = 0;

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
      } else if (ch === "email") {
        credits = emailPricing.creditsPerUnit;
        version = emailPricing.id;
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
      else {
        result.awaiting++;
        if (res[0].wallet_reserve_for_job === "needs_permission") needsPermission += credits;
      }
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
  if (needsPermission > 0 && !opts.allowAwaiting) throw creditsPermissionRequired(needsPermission);
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

/** Subscription details and every-N-months repeat are Pro features. */
async function assertProFields(tx: Db, userId: string, input: ReminderInput): Promise<void> {
  if (!input.subscription) return;
  const { rows } = await tx.query("select 1 from user_plans where user_id = $1 and status = 'active' and starts_at <= now() and ends_at > now() limit 1", [userId]);
  if (!rows[0]) throw new HttpError(403, "Subscriptions are a Nabikaran Pro feature.", "pro_required");
}

const subColumns = (sub: ReminderInput["subscription"]) =>
  sub ? [sub.amount, sub.currency, sub.paymentMethod || null, sub.autoRenew, Boolean(sub.isTrial), sub.cancelNoticeDays ?? null] : [null, null, null, null, false, null];

/** The customer agreed (in this request) to use wallet credits beyond their included messages. */
async function allowCreditsFor(tx: Db, input: { useCredits?: boolean }): Promise<void> {
  if (input.useCredits) await tx.query("select set_config('nabikaran.allow_credits', 'on', true)");
}

export function creditsPermissionRequired(credits: number): HttpError {
  return new HttpError(
    409,
    `Your included Pro messages do not cover all of this reminder. Allow ${credits} wallet credits for the rest? Nothing was saved.`,
    "credits_permission_required",
    { credits },
  );
}

/** "Cancel by" reminders: 3 days, 1 day and on the last day to cancel. */
const CANCEL_OFFSETS = [3 * 1440, 1440, 0];

/**
 * Pro: keep the "cancel by" reminder of a subscription in step with it. It is a
 * normal reminder (own messages, funded like any other) linked to the parent, on
 * the date `cancel_notice_days` before the renewal. Removed when the setting is
 * cleared, the parent stops, or the deadline has passed.
 */
async function syncCancelReminder(tx: Db, parent: RenewalRow, locale: string, now: Date, opts: { allowAwaiting?: boolean } = {}): Promise<void> {
  const { rows: found } = await tx.query<RenewalRow>("select * from renewal_items where linked_to = $1 and status <> 'deleted' for update", [parent.id]);
  const comp = found[0];
  const days = parent.cancel_notice_days;
  const cancelAt = days === null || days === undefined || parent.status !== "active" ? null : new Date(new Date(parent.expiry_at_utc).getTime() - days * 86_400_000);
  if (comp) await cancelUnsentJobs(tx, comp.id, "cancel deadline updated");
  if (!cancelAt || cancelAt.getTime() <= now.getTime()) {
    if (comp) await tx.query("update renewal_items set status = 'deleted', updated_at = now() where id = $1", [comp.id]);
    return;
  }
  const k = utcToKathmandu(cancelAt);
  const d = parent.date_input_calendar === "BS" ? adToBs({ year: k.year, month: k.month, day: k.day }) : { year: k.year, month: k.month, day: k.day };
  const raw = `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;
  // The "last day to cancel" wording exists for SMS and email; WhatsApp templates are renewal-only.
  const channels = normalizeChannels(parent.channels).filter((c) => c !== "whatsapp");
  if (!channels.length) channels.push("sms");
  const { rows } = comp
    ? await tx.query<RenewalRow>(
        `update renewal_items set label = $2, expiry_at_utc = $3, local_time = $4, date_input_calendar = $5, date_input_raw = $6, channels = $7, group_id = $8,
           status = 'active', cycle_no = cycle_no + 1, updated_at = now() where id = $1 returning *`,
        [comp.id, parent.label, cancelAt.toISOString(), parent.local_time, parent.date_input_calendar, raw, channels, parent.group_id ?? null],
      )
    : await tx.query<RenewalRow>(
        `insert into renewal_items (owner_user_id, category, label, expiry_at_utc, local_time, date_input_calendar, date_input_raw, channels, group_id, linked_to)
         values ($1, 'cancel_deadline', $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
        [parent.owner_user_id, parent.label, cancelAt.toISOString(), parent.local_time, parent.date_input_calendar, raw, channels, parent.group_id ?? null, parent.id],
      );
  const plan = planReminders(cancelAt, CANCEL_OFFSETS.map((offsetMinutes) => ({ offsetMinutes })), now);
  await materializeJobs(tx, rows[0], locale, plan.candidates, opts);
}

export interface RenewalHistoryRow {
  id: string;
  renewalId: string | null;
  label: string;
  category: string;
  renewedOn: string;
  amount: number | null;
  currency: string | null;
  previousDue: string | null;
  nextDue: string | null;
  source: "manual" | "auto";
  note: string | null;
}

export async function listRenewalHistory(userId: string, db: Db = getDb(), limit = 200): Promise<RenewalHistoryRow[]> {
  const { rows } = await db.query<{ id: string; renewal_id: string | null; label: string; category: string; renewed_on: string | Date; amount: string | null; currency: string | null; previous_due: string | null; next_due: string | null; source: "manual" | "auto"; note: string | null }>(
    "select id, renewal_id, label, category, renewed_on, amount::text, currency, previous_due, next_due, source, note from renewal_history where user_id = $1 order by renewed_on desc, created_at desc limit $2",
    [userId, limit],
  );
  const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());
  const day = (v: string | Date) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  return rows.map((r) => ({
    id: r.id, renewalId: r.renewal_id, label: r.label, category: r.category, renewedOn: day(r.renewed_on), amount: r.amount === null ? null : Number(r.amount),
    currency: r.currency, previousDue: iso(r.previous_due), nextDue: iso(r.next_due), source: r.source, note: r.note,
  }));
}

export const markRenewedSchema = z.object({
  renewedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().min(0).max(100_000_000).nullable().default(null),
  currency: z.enum(SUB_CURRENCIES).default("NPR"),
  note: z.string().trim().max(200).nullable().default(null),
  /** For a one-time reminder: the new expiry date (same calendar as the reminder). Repeating reminders move on their own. */
  nextExpiryDate: z.string().trim().max(12).nullable().default(null),
  useCredits: z.boolean().optional(),
});

/**
 * Pro: record that a renewal was done (date, cost, note). A one-time reminder
 * moves to the new expiry date (its messages are re-planned and funded); a
 * repeating one keeps its schedule.
 */
export async function markRenewed(p: Principal, renewalId: string, raw: z.input<typeof markRenewedSchema>, db: Db = getDb(), now = new Date()): Promise<{ reminder: ReminderDTO; history: RenewalHistoryRow[] }> {
  requireScope(p, "reminders:write");
  const input = markRenewedSchema.parse(raw);
  return db.tx(async (tx) => {
    const { rows: plan } = await tx.query("select 1 from user_plans where user_id = $1 and status = 'active' and starts_at <= now() and ends_at > now() limit 1", [p.userId]);
    if (!plan[0]) throw new HttpError(403, "Renewal history is a Nabikaran Pro feature.", "pro_required");
    const { rows } = await tx.query<RenewalRow>("select * from renewal_items where id = $1 and owner_user_id = $2 and status <> 'deleted' for update", [renewalId, p.userId]);
    const r = rows[0];
    if (!r) throw new HttpError(404, "Reminder not found", "not_found");
    const repeats = Boolean(r.repeat_yearly || r.repeat_months);
    let next: Date | null = repeats ? new Date(r.expiry_at_utc) : null;
    if (!repeats) {
      if (!input.nextExpiryDate) throw new HttpError(400, "Enter the new expiry date.", "next_expiry_required");
      const { rows: offs } = await tx.query<{ offset_minutes: number }>("select offset_minutes from reminder_rules where renewal_id = $1 and enabled order by offset_minutes desc", [r.id]);
      const res = await updateReminderIn(tx, p, r.id, {
        category: r.category as ReminderInput["category"], label: r.label, calendar: r.date_input_calendar, expiryDate: input.nextExpiryDate, localTime: r.local_time,
        notes: r.notes, familyMemberLabel: r.family_member_label, templateSlug: r.template_slug ?? null, offsets: offs.map((o) => o.offset_minutes),
        channels: normalizeChannels(r.channels), useCredits: input.useCredits,
      }, now, { renewed: true });
      next = new Date(res.reminder.expiry.utc);
    }
    await tx.query(
      `insert into renewal_history (renewal_id, user_id, label, category, renewed_on, amount, currency, previous_due, next_due, source, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10)`,
      [r.id, p.userId, r.label, r.category, input.renewedOn, input.amount, input.amount === null ? null : input.currency, r.expiry_at_utc, next?.toISOString() ?? null, input.note],
    );
    await audit(tx, p, "reminder.renewed", { type: "renewal", id: r.id }, { renewedOn: input.renewedOn, amount: input.amount, currency: input.currency });
    return { reminder: await loadDto(tx, r.id), history: (await listRenewalHistory(p.userId, tx)).filter((h) => h.renewalId === r.id) };
  });
}

/** Transaction-scoped create (no idempotency wrapper). Used by createReminder and by prepared-action confirmation. */
export async function createReminderIn(tx: Db, p: Principal, input: ReminderInput, now = new Date(), detail: Record<string, unknown> = {}): Promise<Omit<MutationResult, "replayed">> {
  requireScope(p, "reminders:write");
  await assertNotLocked(p.userId, tx);
  await assertProFields(tx, p.userId, input);
  await allowCreditsFor(tx, input);
  const repeatMonths = input.repeatMonths ?? null;
  const repeatYearly = Boolean(input.repeatYearly) && !repeatMonths;
  const sched = resolveSchedule(input, repeatYearly, now, repeatMonths);
  const expiryAtUtc = sched.expiryAtUtc;
  const plan = planReminders(expiryAtUtc, input.offsets.map((offsetMinutes) => ({ offsetMinutes })), now);
  const channels = await prepareChannels(tx, p, input);
  await assertOwnGroup(tx, p.userId, input.groupId);
  const { rows } = await tx.query<RenewalRow>(
    `insert into renewal_items (owner_user_id, category, label, expiry_at_utc, local_time, date_input_calendar, date_input_raw, notes, family_member_label, template_slug, channels, group_id, repeat_yearly, repeat_anchor,
       repeat_months, sub_amount, sub_currency, sub_payment_method, sub_auto_renew, sub_is_trial, cancel_notice_days)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,(select slug from document_templates where slug = $10),$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning *`,
    [p.userId, input.category, input.label, expiryAtUtc.toISOString(), input.localTime, input.calendar, sched.raw, input.notes ?? null, input.familyMemberLabel ?? null, input.templateSlug ?? null, channels,
      input.groupId ?? null, repeatYearly, sched.anchor ? anchorToString(sched.anchor) : null, repeatMonths, ...subColumns(input.subscription)],
  );
  const renewal = rows[0];
  const repeats = repeatYearly || Boolean(repeatMonths);
  const summary = await materializeJobs(tx, renewal, p.locale, plan.candidates, { keepOffsets: repeats ? input.offsets : [] });
  await syncCancelReminder(tx, renewal, p.locale, now);
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
  resolveSchedule(input, Boolean(input.repeatYearly) && !input.repeatMonths, now, input.repeatMonths ?? null);
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
  // Omitted group / repeat / subscription fields keep their current values (assistants and older callers do not send them).
  await assertProFields(tx, p.userId, input);
  await allowCreditsFor(tx, input);
  const repeatMonths = input.repeatMonths === undefined ? existing[0].repeat_months ?? null : input.repeatMonths;
  const repeatYearly = (input.repeatYearly ?? Boolean(existing[0].repeat_yearly)) && !repeatMonths;
  const groupId = input.groupId === undefined ? existing[0].group_id ?? null : input.groupId;
  const keepSub = input.subscription === undefined;
  const e0 = existing[0];
  const sub = keepSub ? [e0.sub_amount ?? null, e0.sub_currency ?? null, e0.sub_payment_method ?? null, e0.sub_auto_renew ?? null, Boolean(e0.sub_is_trial), e0.cancel_notice_days ?? null] : subColumns(input.subscription);
  const sched = resolveSchedule(input, repeatYearly, now, repeatMonths);
  const expiryAtUtc = sched.expiryAtUtc;
  const plan = planReminders(expiryAtUtc, input.offsets.map((offsetMinutes) => ({ offsetMinutes })), now);
  const channels = await prepareChannels(tx, p, input);
  await assertOwnGroup(tx, p.userId, groupId);
  const cancelled = await cancelUnsentJobs(tx, renewalId, "superseded by edit");
  const { rows } = await tx.query<RenewalRow>(
    `update renewal_items set category=$3, label=$4, expiry_at_utc=$5, local_time=$6, date_input_calendar=$7, date_input_raw=$8, notes=$9,
       family_member_label=$10, channels=$11, template_slug = coalesce((select slug from document_templates where slug = $12), template_slug),
       group_id=$13, repeat_yearly=$14, repeat_anchor=$15, repeat_months=$16, sub_amount=$17, sub_currency=$18, sub_payment_method=$19, sub_auto_renew=$20, sub_is_trial=$21, cancel_notice_days=$22,
       status='active', cycle_no = cycle_no + 1, updated_at = now()
     where id = $1 and owner_user_id = $2 returning *`,
    [renewalId, p.userId, input.category, input.label, expiryAtUtc.toISOString(), input.localTime, input.calendar, sched.raw, input.notes ?? null, input.familyMemberLabel ?? null, channels, input.templateSlug ?? null,
      groupId, repeatYearly, sched.anchor ? anchorToString(sched.anchor) : null, repeatMonths, ...sub],
  );
  const renewal = rows[0];
  const repeats = repeatYearly || Boolean(repeatMonths);
  const summary = { ...(await materializeJobs(tx, renewal, p.locale, plan.candidates, { keepOffsets: repeats ? input.offsets : [] })), cancelled };
  await syncCancelReminder(tx, renewal, p.locale, now);
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
  if (input.repeatYearly !== undefined && !input.repeatMonths) resolveSchedule(input, input.repeatYearly, now, input.repeatMonths ?? null);
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
  opts: { idempotencyKey?: string | null; useCredits?: boolean } = {},
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
        await allowCreditsFor(tx, { useCredits: opts.useCredits });
        await tx.query("update renewal_items set status = 'active', updated_at = now() where id = $1", [renewalId]);
        const { rows: jobs } = await tx.query<{ id: string }>(
          "select id from reminder_jobs where renewal_id = $1 and cycle_no = $2 and status = 'cancelled' and last_error = 'paused' and due_at_utc > now()",
          [renewalId, r.cycle_no],
        );
        let short = 0;
        let permission = 0;
        for (const j of jobs) {
          await tx.query("update reminder_jobs set status = 'planned', last_error = null, updated_at = now() where id = $1", [j.id]);
          const { rows: res } = await tx.query<{ wallet_reserve_for_job: string }>("select wallet_reserve_for_job($1)", [j.id]);
          if (res[0].wallet_reserve_for_job === "needs_permission") permission++;
          if (res[0].wallet_reserve_for_job !== "scheduled") short++;
        }
        if (permission > 0) {
          const { rows: need } = await tx.query<{ n: string }>("select coalesce(sum(estimated_credits),0)::text as n from reminder_jobs where id = any($1::uuid[]) and status = 'awaiting_credits'", [jobs.map((j) => j.id)]);
          throw creditsPermissionRequired(Number(need[0].n));
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
        // The subscription's "cancel by" reminder follows it.
        const { rows: linked } = await tx.query<{ id: string }>("select id from renewal_items where linked_to = $1 and status <> 'deleted'", [renewalId]);
        for (const l of linked) {
          cancelled += await cancelUnsentJobs(tx, l.id, action === "pause" ? "paused" : status);
          await tx.query("update renewal_items set status = $2, updated_at = now() where id = $1", [l.id, status]);
        }
      }
      if (action === "resume") {
        const { rows: cur } = await tx.query<RenewalRow>("select * from renewal_items where id = $1", [renewalId]);
        if (cur[0]?.cancel_notice_days !== null && cur[0]?.cancel_notice_days !== undefined) {
          await tx.query("update renewal_items set status = 'active' where linked_to = $1 and status = 'paused'", [renewalId]);
          await syncCancelReminder(tx, cur[0], p.locale, new Date());
        }
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
      where (i.repeat_yearly or i.repeat_months is not null) and i.status = 'active' and i.expiry_at_utc < $1
        and not exists (select 1 from reminder_jobs j where j.renewal_id = i.id and j.cycle_no = i.cycle_no and j.status in ('scheduled','sending','unknown'))
      order by i.expiry_at_utc limit $2`,
    [new Date(now.getTime() - 6 * 3600_000).toISOString(), limit],
  );
  for (const d of due) {
    await db.tx(async (tx) => {
      const { rows } = await tx.query<RenewalRow & { locale: string }>(
        `select i.*, u.locale from renewal_items i join users u on u.id = i.owner_user_id
          where i.id = $1 and (i.repeat_yearly or i.repeat_months is not null) and i.status = 'active' for update of i skip locked`,
        [d.id],
      );
      const r = rows[0];
      if (!r) return;
      const anchor = parseAnchor(r.repeat_anchor) ?? anchorFromInput(r.date_input_raw ?? "");
      const after = new Date(Math.max(now.getTime(), new Date(r.expiry_at_utc).getTime()));
      const next = !anchor
        ? null
        : r.repeat_months
          ? nextEveryMonths(r.date_input_calendar, r.date_input_raw ?? "", r.local_time, r.repeat_months, after, anchor.day)
          : nextOccurrence(r.date_input_calendar, anchor, r.local_time, after, 0);
      if (!next) {
        await tx.query("update renewal_items set repeat_yearly = false, repeat_months = null, updated_at = now() where id = $1", [r.id]);
        await tx.query("insert into audit_events (actor_via, action, target_type, target_id, json_detail_redacted) values ('worker','reminder.rollover_stopped','renewal',$1,'{}')", [r.id]);
        return;
      }
      // Messages of the finished year that were never funded are closed, not sent late.
      await cancelUnsentJobs(tx, r.id, "missed: year ended without credits");
      // A subscription renewed (or a free trial turned paid): keep it in the renewal history.
      const isSub = r.category === "subscription" || r.category === "free_trial" || r.sub_amount !== null && r.sub_amount !== undefined;
      if (isSub) {
        const k = utcToKathmandu(new Date(r.expiry_at_utc));
        await tx.query(
          `insert into renewal_history (renewal_id, user_id, label, category, renewed_on, amount, currency, previous_due, next_due, source, note)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'auto',$10)`,
          [r.id, r.owner_user_id, r.label, r.category, `${k.year}-${pad2(k.month)}-${pad2(k.day)}`, r.sub_amount ?? null, r.sub_amount === null || r.sub_amount === undefined ? null : r.sub_currency ?? "NPR",
            r.expiry_at_utc, next.utc.toISOString(), r.sub_is_trial ? "Free trial ended; now a paid subscription" : null],
        );
      }
      const { rows: upd } = await tx.query<RenewalRow>(
        `update renewal_items set expiry_at_utc = $2, date_input_raw = $3, cycle_no = cycle_no + 1,
           category = case when category = 'free_trial' then 'subscription' else category end, sub_is_trial = false, updated_at = now()
         where id = $1 returning *`,
        [r.id, next.utc.toISOString(), next.raw],
      );
      const { rows: offs } = await tx.query<{ offset_minutes: number }>("select offset_minutes from reminder_rules where renewal_id = $1 and enabled", [r.id]);
      const plan = planReminders(next.utc, offs.map((o) => ({ offsetMinutes: o.offset_minutes })), now);
      const summary = await materializeJobs(tx, upd[0], r.locale, plan.candidates, { allowAwaiting: true, keepOffsets: offs.map((o) => o.offset_minutes) });
      await syncCancelReminder(tx, upd[0], r.locale, now, { allowAwaiting: true });
      await tx.query("insert into audit_events (actor_via, action, target_type, target_id, json_detail_redacted) values ('worker','reminder.rollover','renewal',$1,$2)", [
        r.id, JSON.stringify({ next: next.raw, ...summary }),
      ]);
      out.rolled++;
      if (summary.awaiting > 0) out.awaitingCredits++;
    });
  }
  return out;
}
