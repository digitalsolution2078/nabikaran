import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { setBusinessAccess } from "@/lib/services/clients";

const schema = z.object({ allowed: z.boolean(), name: z.string().trim().max(40).nullable().optional() });

/** Admin: give or take away business tools (clients) for a customer. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const admin = await requirePermission(req, "business.grant");
    const { id } = await ctx.params;
    const body = await parseBody(req, schema);
    return json(await setBusinessAccess(admin, id, body.allowed, body.name));
  });
}
