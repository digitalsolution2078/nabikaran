import { z } from "zod";
import { handle, json, parseBody, requirePrincipal, idempotencyKeyFrom, HttpError } from "@/lib/http";
import { getReminder, previewSchedule, updateReminder } from "@/lib/core/reminders";
import { MAX_OFFSET_MINUTES } from "@/lib/scheduler";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  offsets: z.array(z.number().int().min(0).max(MAX_OFFSET_MINUTES)).min(1).max(20),
  confirm: z.boolean().default(false),
  idempotencyKey: z.string().max(64).optional().nullable(),
});

/**
 * Preview (confirm=false) or apply (confirm=true) a reminder schedule for an
 * existing renewal. Applying is a versioned update that cancels unsent jobs
 * from the previous cycle and reserves credits for the new plan.
 */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    const { id } = await ctx.params;
    const renewalId = z.string().uuid().parse(id);
    const body = await parseBody(req, schema);
    const existing = await getReminder(principal, renewalId);
    if (!existing) throw new HttpError(404, "Reminder not found", "not_found");
    const base = {
      label: existing.label,
      calendar: existing.inputCalendar,
      expiryDate: existing.inputDate ?? existing.expiry.ad,
      localTime: existing.localTime,
      offsets: body.offsets,
    };
    const preview = await previewSchedule(principal, base);
    if (!body.confirm) return json({ preview });
    const result = await updateReminder(
      principal,
      renewalId,
      { ...base, category: existing.category as never, notes: existing.notes, familyMemberLabel: existing.familyMemberLabel },
      { idempotencyKey: idempotencyKeyFrom(req, body) },
    );
    return json({ preview, ...result });
  });
}
