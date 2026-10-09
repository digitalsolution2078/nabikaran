import { z } from "zod";
import { getDb, type Db } from "../db";
import { MAX_OFFSET_MINUTES } from "../scheduler";
import { audit } from "./audit";
import { instantDTO, type ReminderDTO, type SchedulePreview, type Warning } from "./dto";
import { HttpError } from "./errors";
import { withIdempotency } from "./idempotency";
import { requireScope, type Principal } from "./principal";
import { CATEGORIES, createReminderIn, getReminder, previewSchedule, resolveExpiry, updateReminderIn, type ReminderInput } from "./reminders";
import { getActivePricing } from "./wallet";

/**
 * Two-step preview-and-confirm for actions that reserve credits (docs §6, §8).
 *
 *  prepare  — side-effect free apart from storing a snapshot: validates the
 *             structured input, renders the exact SMS text and cost, pins the
 *             pricing version, and decides whether the user must explicitly
 *             confirm the date (BS input, or a date the assistant extracted /
 *             inferred rather than the user typing it).
 *  confirm  — consumes the snapshot exactly once (row lock + consumed_at),
 *             re-checks ownership, expiry and pricing, requires the caller to
 *             echo the resolved Gregorian date, then runs the core mutation in
 *             the same transaction. Replays return the same result.
 *
 * Image bytes are never accepted: the assistant extracts structured fields on
 * its side and the user confirms them.
 */
export const PREPARED_TTL_SECONDS = 15 * 60;

export const prepareInputSchema = z.object({
  reminder_id: z.string().uuid().optional(),
  category: z.enum(CATEGORIES),
  label: z.string().trim().min(1).max(80),
  expiry: z.object({
    calendar: z.enum(["AD", "BS"]),
    date: z.string().trim().min(8).max(12),
    local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
    source: z.enum(["user_typed", "extracted_from_image", "inferred"]).default("user_typed"),
    user_confirmed: z.boolean().default(false),
  }),
  offsets_minutes: z.array(z.number().int().min(0).max(MAX_OFFSET_MINUTES)).min(1).max(20),
  family_member_label: z.string().trim().max(60).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});
export type PrepareInput = z.infer<typeof prepareInputSchema>;

export interface PreparedAction {
  preparedId: string;
  kind: "create_reminder" | "update_reminder";
  expiresAt: string;
  preview: SchedulePreview;
  requiresUserConfirmation: boolean;
  confirmationPrompt: string;
  warnings: Warning[];
}

function toReminderInput(i: PrepareInput): ReminderInput {
  return {
    category: i.category,
    label: i.label,
    calendar: i.expiry.calendar,
    expiryDate: i.expiry.date,
    localTime: i.expiry.local_time,
    notes: i.notes ?? null,
    familyMemberLabel: i.family_member_label ?? null,
    offsets: i.offsets_minutes,
  };
}

function needsConfirmation(i: PrepareInput): boolean {
  return i.expiry.calendar === "BS" || i.expiry.source !== "user_typed";
}

function buildPrompt(i: PrepareInput, preview: SchedulePreview): string {
  const ad = preview.expiry.ad;
  const bs = preview.expiry.bs?.display ?? "—";
  const why = i.expiry.calendar === "BS" ? "You entered a Bikram Sambat date" : i.expiry.source === "extracted_from_image" ? "This date was read from a document image" : "This date was inferred";
  return `${why}. Please confirm: expiry ${ad} (AD) = ${bs} (BS), ${preview.expiry.local} Nepal time. ${preview.lines.length} SMS reminder(s), ${preview.reservedOnConfirmCredits} credits reserved now. ` +
    `म्याद सकिने मिति ${ad} (ई.सं.) = ${bs} (वि.सं.) हो? पुष्टि गर्नुहोस्।`;
}

export async function prepareReminderAction(p: Principal, raw: unknown, db: Db = getDb(), now = new Date()): Promise<PreparedAction> {
  requireScope(p, "reminders:write");
  const parsed = prepareInputSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "invalid_input");
  const input = parsed.data;
  resolveExpiry({ calendar: input.expiry.calendar, expiryDate: input.expiry.date, localTime: input.expiry.local_time }); // throws invalid_date / invalid_bs_date
  const kind = input.reminder_id ? "update_reminder" : "create_reminder";
  if (input.reminder_id && !(await getReminder(p, input.reminder_id, db))) throw new HttpError(404, "Reminder not found", "not_found");

  const preview = await previewSchedule(p, toReminderInput(input), db, now);
  if (preview.lines.length === 0) throw new HttpError(400, "Every reminder time is already in the past; choose an earlier offset or a later expiry.", "nothing_to_schedule");
  const requiresUserConfirmation = needsConfirmation(input);
  const confirmationPrompt = requiresUserConfirmation ? buildPrompt(input, preview) : `Schedule ${preview.lines.length} SMS reminder(s) for ${input.label}, expiring ${preview.expiry.local} Nepal time, reserving ${preview.reservedOnConfirmCredits} credits now?`;

  const { rows } = await db.query<{ id: string; expires_at: string }>(
    `insert into prepared_actions (user_id, client_id, kind, input, preview, pricing_version, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7)) returning id, expires_at`,
    [p.userId, p.clientId ?? null, kind, JSON.stringify(input), JSON.stringify(preview), preview.pricingVersion, PREPARED_TTL_SECONDS],
  );
  await audit(db, p, "reminder.prepare", { type: "prepared_action", id: rows[0].id }, { kind, requiresUserConfirmation, warnings: preview.warnings, credits: preview.reservedOnConfirmCredits });
  return {
    preparedId: rows[0].id,
    kind,
    expiresAt: new Date(rows[0].expires_at).toISOString(),
    preview,
    requiresUserConfirmation,
    confirmationPrompt,
    warnings: preview.warnings,
  };
}

export interface ConfirmInput {
  preparedId: string;
  expectedExpiryAd: string;
  idempotencyKey?: string | null;
}

export interface ConfirmResult {
  reminder: ReminderDTO;
  reservedCredits: number;
  funding: { status: "reserved" | "awaiting_credits" | "partially_reserved"; shortfallCredits: number };
  replayed: boolean;
}

export async function confirmPreparedAction(p: Principal, c: ConfirmInput, db: Db = getDb(), now = new Date()): Promise<ConfirmResult> {
  requireScope(p, "reminders:write");
  if (!/^[0-9a-f-]{36}$/i.test(c.preparedId)) throw new HttpError(404, "Prepared action not found", "not_found");
  return db.tx(async (tx) => {
    const { result, replayed } = await withIdempotency(tx, p.userId, c.idempotencyKey, "confirm_reminder", async () => {
      const { rows } = await tx.query<{
        id: string; user_id: string; kind: "create_reminder" | "update_reminder"; input: PrepareInput; preview: SchedulePreview; pricing_version: string | number; expires_at: string; consumed_at: string | null; result_ref: string | null;
      }>("select * from prepared_actions where id = $1 for update", [c.preparedId]);
      const pa = rows[0];
      if (!pa || pa.user_id !== p.userId) throw new HttpError(404, "Prepared action not found", "not_found");

      if (pa.consumed_at) {
        // Replay without an idempotency key: return the committed result, create nothing.
        if (!pa.result_ref) throw new HttpError(409, "Prepared action already used", "already_confirmed");
        const existing = await getReminder(p, pa.result_ref, tx);
        if (!existing) throw new HttpError(409, "Prepared action already used", "already_confirmed");
        return { reminder: existing, reservedCredits: 0, funding: fundingOf(existing), replayedInner: true };
      }
      if (new Date(pa.expires_at).getTime() < now.getTime()) throw new HttpError(410, "Prepared action expired; call prepare_reminder again.", "prepared_expired");

      const pricing = await getActivePricing(tx);
      if (Number(pa.pricing_version) !== pricing.id) throw new HttpError(409, "Pricing changed since the preview; call prepare_reminder again to see the new cost.", "price_changed");

      const input = pa.input;
      const resolvedAd = pa.preview.expiry.ad;
      if (c.expectedExpiryAd !== resolvedAd) {
        throw new HttpError(409, `expected_expiry_ad must equal the resolved Gregorian date ${resolvedAd}; show it to the user and confirm.`, "expiry_mismatch");
      }
      if (needsConfirmation(input) && !input.expiry.user_confirmed) {
        throw new HttpError(409, "This date needs explicit user confirmation. Show the converted date, then call prepare_reminder again with expiry.user_confirmed=true.", "confirmation_required");
      }
      // Re-resolve now: the live schedule must still match what was previewed (same expiry instant).
      const liveExpiry = instantDTO(resolveExpiry({ calendar: input.expiry.calendar, expiryDate: input.expiry.date, localTime: input.expiry.local_time }));
      if (liveExpiry.utc !== pa.preview.expiry.utc) throw new HttpError(409, "Expiry resolution changed; prepare again.", "preview_stale");

      const detail = { preparedId: pa.id, idempotencyKey: c.idempotencyKey ?? null };
      const out = pa.kind === "update_reminder"
        ? await updateReminderIn(tx, p, input.reminder_id!, toReminderInput(input), now, detail)
        : await createReminderIn(tx, p, toReminderInput(input), now, detail);
      await tx.query("update prepared_actions set consumed_at = now(), result_ref = $2 where id = $1", [pa.id, out.reminder.id]);
      const reserved = out.reminder.jobs.filter((j) => j.status === "scheduled").reduce((s, j) => s + j.estimatedCredits, 0);
      await audit(tx, p, "reminder.confirm", { type: "renewal", id: out.reminder.id }, { preparedId: pa.id, reserved, summary: out.summary });
      return { reminder: out.reminder, reservedCredits: reserved, funding: fundingOf(out.reminder), replayedInner: false };
    });
    const { replayedInner, ...rest } = result;
    return { ...rest, replayed: replayed || replayedInner };
  });
}

function fundingOf(r: ReminderDTO): ConfirmResult["funding"] {
  const awaiting = r.jobs.filter((j) => j.status === "awaiting_credits");
  const scheduled = r.jobs.filter((j) => j.status === "scheduled");
  const shortfallCredits = awaiting.reduce((s, j) => s + j.estimatedCredits, 0);
  if (awaiting.length === 0) return { status: "reserved", shortfallCredits: 0 };
  return { status: scheduled.length === 0 ? "awaiting_credits" : "partially_reserved", shortfallCredits };
}

/** Housekeeping for the reconciler. */
export async function prunePreparedActions(db: Db = getDb()): Promise<void> {
  await db.query("delete from prepared_actions where expires_at < now() - interval '1 day' and consumed_at is null");
}
