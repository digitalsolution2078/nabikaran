import { z } from "zod";
import { handle, json, parseBody, requirePermission, HttpError } from "@/lib/http";
import { getDb } from "@/lib/db";
import { getPlanState, grantPro, revokePlan } from "@/lib/services/plans";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("grant"), days: z.number().int().min(1).max(730), withAllowances: z.boolean(), note: z.string().trim().min(3).max(200) }),
  z.object({ action: z.literal("revoke"), planId: z.string().uuid(), reason: z.string().trim().min(3).max(200) }),
]);

/** Super admin: give or end Pro for a customer. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const admin = await requirePermission(req, "plans.grant");
    const { id } = await ctx.params;
    const body = await parseBody(req, schema);
    if (body.action === "grant") return json(await grantPro(admin, id, { days: body.days, withAllowances: body.withAllowances, note: body.note }));
    const { rows } = await getDb().query("select 1 from user_plans where id = $1 and user_id = $2", [body.planId, id]);
    if (!rows[0]) throw new HttpError(404, "Plan not found for this customer", "not_found");
    await revokePlan(admin, body.planId, body.reason);
    return json(await getPlanState(id));
  });
}
