import { z } from "zod";
import { handle, json, parseBody, requirePermission, HttpError } from "@/lib/http";
import { approveManualTopup, rejectManualTopup } from "@/lib/services/manual-topups";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), bankRef: z.string().trim().min(4).max(80), notes: z.string().max(300).optional().nullable(), confirm: z.literal(true) }),
  z.object({ action: z.literal("reject"), reason: z.string().trim().min(3).max(300), confirm: z.literal(true) }),
]);

/**
 * Approve only after matching the payment in the bank/merchant statement; the
 * statement's own transaction reference is mandatory and can fund only one request.
 */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const admin = await requirePermission(req, "topups.decide");
    const { id } = await ctx.params;
    const requestId = z.string().uuid().parse(id);
    const body = await parseBody(req, schema).catch((e) => {
      throw e instanceof z.ZodError ? new HttpError(400, "Confirmation, bank reference (approve) or reason (reject) required", "invalid_input") : e;
    });
    if (body.action === "approve") return json(await approveManualTopup(admin.id, requestId, body.bankRef, body.notes ?? null));
    return json(await rejectManualTopup(admin.id, requestId, body.reason));
  });
}
