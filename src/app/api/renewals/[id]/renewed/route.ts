import { handle, json, parseBody, requirePrincipal, limit } from "@/lib/http";
import { markRenewed, markRenewedSchema } from "@/lib/core/reminders";

/** Pro: record a completed renewal (date, cost); a one-time reminder moves to its new expiry date. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    await limit(`user:${principal.userId}`, "reminder:write", 60, 60);
    const { id } = await ctx.params;
    const body = await parseBody(req, markRenewedSchema);
    return json(await markRenewed(principal, id, body));
  });
}
