import { z } from "zod";
import { handle, json, parseBody, requireAdmin, HttpError } from "@/lib/http";
import { can } from "@/lib/auth/rbac";
import { directAdjustment, setUserRole } from "@/lib/services/admin-console";
import { requestWalletAdjustment } from "@/lib/services/admin";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("role"), role: z.enum(["user", "admin", "super_admin", "finance", "support", "content", "auditor", "counter"]), confirm: z.literal(true) }),
  z.object({
    action: z.literal("adjust"),
    direction: z.enum(["credit", "debit"]),
    credits: z.number().int().positive().max(100000),
    reason: z.string().trim().min(5).max(300),
    idempotencyKey: z.string().min(8).max(64),
    confirm: z.literal(true),
  }),
]);

export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const admin = await requireAdmin(req);
    const { id } = await ctx.params;
    const userId = z.string().uuid().parse(id);
    const body = await parseBody(req, schema);
    if (body.action === "role") {
      if (!can(admin.role, "roles.manage")) throw new HttpError(403, "Only a Super Admin can change roles", "forbidden");
      await setUserRole({ id: admin.id, role: admin.role }, userId, body.role);
      return json({ ok: true });
    }
    const signed = body.direction === "credit" ? body.credits : -body.credits;
    if (can(admin.role, "adjustments.direct")) {
      const requestId = await directAdjustment(admin.id, userId, signed, body.reason, body.idempotencyKey);
      return json({ ok: true, applied: true, requestId });
    }
    if (!can(admin.role, "adjustments.request")) throw new HttpError(403, "Not allowed", "forbidden");
    if (userId === admin.id) throw new HttpError(400, "You cannot adjust your own wallet", "self_adjustment");
    const requestId = await requestWalletAdjustment(admin.id, userId, signed, body.reason);
    return json({ ok: true, applied: false, requestId, note: "Pending approval by another admin" });
  });
}
