import { z } from "zod";
import { handle, json, parseBody, requirePrincipal, idempotencyKeyFrom, HttpError, limit } from "@/lib/http";
import { getReminder, reminderInputSchema, setReminderStatus, updateReminder } from "@/lib/core/reminders";

type Ctx = { params: Promise<{ id: string }> };
const uuid = z.string().uuid();

export async function GET(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    const { id } = await ctx.params;
    const reminder = await getReminder(principal, uuid.parse(id));
    if (!reminder) throw new HttpError(404, "Reminder not found", "not_found");
    return json({ reminder });
  });
}

const patchSchema = z.union([
  z.object({ action: z.enum(["pause", "resume", "cancel"]), idempotencyKey: z.string().max(64).optional().nullable(), useCredits: z.boolean().optional() }),
  reminderInputSchema.extend({ idempotencyKey: z.string().max(64).optional().nullable() }),
]);

/** Versioned update: a full edit starts a new cycle; action patches change status. */
export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    await limit(`user:${principal.userId}`, "reminder:write", 60, 60);
    const { id } = await ctx.params;
    const renewalId = uuid.parse(id);
    const body = await parseBody(req, patchSchema);
    const key = idempotencyKeyFrom(req, body);
    if ("action" in body) return json(await setReminderStatus(principal, renewalId, body.action, { idempotencyKey: key, useCredits: body.useCredits }));
    const { idempotencyKey: _k, ...input } = body;
    void _k;
    return json(await updateReminder(principal, renewalId, input, { idempotencyKey: key }));
  });
}

export async function DELETE(req: Request, ctx: Ctx) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    await limit(`user:${principal.userId}`, "reminder:write", 60, 60);
    const { id } = await ctx.params;
    return json(await setReminderStatus(principal, uuid.parse(id), "delete", { idempotencyKey: idempotencyKeyFrom(req) }));
  });
}
