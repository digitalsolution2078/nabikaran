import { z } from "zod";
import { handle, json, parseBody, requirePrincipal, idempotencyKeyFrom, limit } from "@/lib/http";
import { createReminder, listReminders, reminderInputSchema } from "@/lib/core/reminders";

export async function GET(req: Request) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    const url = new URL(req.url);
    const status = url.searchParams.get("status") as "active" | "paused" | "cancelled" | "all" | null;
    return json(await listReminders(principal, { status: status ?? "all", limit: 50 }));
  });
}

const bodySchema = reminderInputSchema.extend({ idempotencyKey: z.string().max(64).optional().nullable() });

export async function POST(req: Request) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    await limit(`user:${principal.userId}`, "reminder:write", 60, 60);
    const body = await parseBody(req, bodySchema);
    const { idempotencyKey, ...input } = body;
    const result = await createReminder(principal, input, { idempotencyKey: idempotencyKeyFrom(req, { idempotencyKey }) });
    return json(result, { status: result.replayed ? 200 : 201 });
  });
}
