import { z } from "zod";
import { getDb, type Db } from "../db";
import { HttpError } from "../core/errors";
import { audit } from "../core/audit";
import { requireScope, type Principal } from "../core/principal";
import { assertNotLocked } from "../core/account-lock";
import { withIdempotency } from "../core/idempotency";
import { getActivePricing, readWallet } from "../core/wallet";
import { createReminderIn, insufficientCredits, loadTemplates, resolveSchedule } from "../core/reminders";
import { planReminders } from "../scheduler";
import { renderReminder } from "../sms/templates";
import { CATEGORIES, categorySmsName } from "../categories";
import { MAX_IMPORT_BYTES, parseImport, type ParsedRow, type RowError } from "../csv-import";
import { createGroupIn, groupInputSchema } from "./groups";

export const importRequestSchema = z.object({
  csv: z.string().min(1).max(MAX_IMPORT_BYTES),
  groupId: z.string().uuid().nullable().optional(),
  newGroup: groupInputSchema.nullable().optional(),
  defaults: z.object({
    calendar: z.enum(["AD", "BS"]),
    category: z.enum(CATEGORIES),
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    offsetsDays: z.array(z.number().int().min(0).max(1825)).min(1).max(10),
    repeatYearly: z.boolean(),
  }),
  /** Import the valid rows and skip the rest (required when some rows have errors). */
  skipInvalid: z.boolean().optional(),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;

export type ImportRowError = RowError | "past_date" | "no_messages";

export interface ImportRowPreview {
  line: number;
  label: string;
  inputDate: string;
  calendar: "AD" | "BS";
  category: string;
  repeatYearly: boolean;
  /** Date the reminder is set for (for a yearly row: the next occurrence), in the input calendar. */
  nextDate: string | null;
  nextAtUtc: string | null;
  messages: number;
  credits: number;
  smsSample: string | null;
  labelAdjusted: boolean;
  duplicate: boolean;
  errors: ImportRowError[];
}

export interface ImportPreview {
  rows: ImportRowPreview[];
  headerDetected: boolean;
  tooMany: boolean;
  validRows: number;
  invalidRows: number;
  messages: number;
  totalCredits: number;
  available: number;
  shortfallCredits: number;
  sufficient: boolean;
}

function toReminderInput(r: ParsedRow) {
  return {
    category: r.category,
    label: r.label,
    calendar: r.calendar,
    expiryDate: r.date,
    localTime: r.localTime,
    notes: r.notes,
    familyMemberLabel: r.familyMemberLabel,
    offsets: r.offsets,
    channels: ["sms" as const],
    repeatYearly: r.repeatYearly,
  };
}

async function buildPreview(p: Principal, req: ImportRequest, db: Db, now: Date): Promise<{ preview: ImportPreview; parsed: ParsedRow[] }> {
  const parsed = parseImport(req.csv, req.defaults);
  const [pricing, templates, wallet] = await Promise.all([getActivePricing(db, "sms"), loadTemplates(db), readWallet(p.userId, db)]);
  const rows: ImportRowPreview[] = parsed.rows.map((r) => {
    const out: ImportRowPreview = {
      line: r.line, label: r.label, inputDate: r.date, calendar: r.calendar, category: r.category, repeatYearly: r.repeatYearly,
      nextDate: null, nextAtUtc: null, messages: 0, credits: 0, smsSample: null, labelAdjusted: false, duplicate: r.duplicate, errors: [...r.errors],
    };
    if (out.errors.length) return out;
    try {
      const s = resolveSchedule({ calendar: r.calendar, expiryDate: r.date, localTime: r.localTime }, r.repeatYearly, now);
      out.nextDate = s.raw;
      out.nextAtUtc = s.expiryAtUtc.toISOString();
      if (s.expiryAtUtc.getTime() <= now.getTime()) {
        out.errors.push("past_date");
        return out;
      }
      const plan = planReminders(s.expiryAtUtc, r.offsets.map((offsetMinutes) => ({ offsetMinutes })), now);
      for (const c of plan.candidates) {
        const m = renderReminder({ label: r.label, fallbackLabel: categorySmsName(r.category), expiryAtUtc: s.expiryAtUtc, dueAtUtc: c.dueAtUtc, locale: p.locale, category: r.category }, templates);
        out.messages++;
        out.credits += m.estimate.segments * pricing.creditsPerUnit;
        out.smsSample ??= m.body;
        out.labelAdjusted ||= m.labelAdjusted;
      }
      if (out.messages === 0) out.errors.push("no_messages");
    } catch {
      out.errors.push("bad_date");
    }
    return out;
  });
  const valid = rows.filter((r) => r.errors.length === 0);
  const totalCredits = valid.reduce((n, r) => n + r.credits, 0);
  const shortfallCredits = Math.max(0, totalCredits - wallet.available);
  return {
    parsed: parsed.rows,
    preview: {
      rows,
      headerDetected: parsed.headerDetected,
      tooMany: parsed.tooMany,
      validRows: valid.length,
      invalidRows: rows.length - valid.length,
      messages: valid.reduce((n, r) => n + r.messages, 0),
      totalCredits,
      available: wallet.available,
      shortfallCredits,
      sufficient: shortfallCredits === 0,
    },
  };
}

/** Side-effect-free check of a CSV: per-row date, messages, cost and errors, plus the total. */
export async function previewImport(p: Principal, req: ImportRequest, db: Db = getDb(), now = new Date()): Promise<ImportPreview> {
  requireScope(p, "reminders:read");
  return (await buildPreview(p, req, db, now)).preview;
}

/**
 * Create every valid row as an SMS reminder in one transaction. All-or-nothing:
 * if the wallet cannot cover every message of every row, nothing is saved.
 */
export async function commitImport(
  p: Principal,
  req: ImportRequest,
  opts: { idempotencyKey?: string | null } = {},
  db: Db = getDb(),
  now = new Date(),
): Promise<{ created: number; groupId: string | null; reservedCredits: number; replayed: boolean }> {
  requireScope(p, "reminders:write");
  if (req.groupId && req.newGroup) throw new HttpError(400, "Choose an existing group or a new one, not both", "invalid_request");
  return db.tx(async (tx) => {
    const { result, replayed } = await withIdempotency(tx, p.userId, opts.idempotencyKey, "import_reminders", async () => {
      await assertNotLocked(p.userId, tx);
      const { preview, parsed } = await buildPreview(p, req, tx, now);
      if (preview.tooMany) throw new HttpError(400, "Too many rows: import at most 300 at a time.", "too_many_rows");
      if (preview.validRows === 0) throw new HttpError(400, "No valid rows to import.", "import_empty");
      if (preview.invalidRows > 0 && !req.skipInvalid) throw new HttpError(400, `${preview.invalidRows} row(s) have errors. Fix them or choose to skip them.`, "import_has_errors");
      if (!preview.sufficient) throw insufficientCredits(preview.totalCredits, preview.available);

      let groupId = req.groupId ?? null;
      if (groupId) {
        const { rows } = await tx.query("select 1 from reminder_groups where id = $1 and owner_user_id = $2", [groupId, p.userId]);
        if (!rows[0]) throw new HttpError(404, "Group not found", "group_not_found");
      } else if (req.newGroup) {
        groupId = (await createGroupIn(tx, p, req.newGroup)).id;
      }

      const ok = new Set(preview.rows.filter((r) => r.errors.length === 0).map((r) => r.line));
      let created = 0;
      for (const r of parsed) {
        if (!ok.has(r.line)) continue;
        await createReminderIn(tx, p, { ...toReminderInput(r), groupId }, now, { via: "import" });
        created++;
      }
      await audit(tx, p, "reminder.import", groupId ? { type: "reminder_group", id: groupId } : null, {
        created, skipped: preview.invalidRows, credits: preview.totalCredits,
      });
      return { created, groupId, reservedCredits: preview.totalCredits };
    });
    return { ...result, replayed };
  });
}
