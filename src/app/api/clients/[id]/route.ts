import { handle, json, parseBody, requireUser } from "@/lib/http";
import { archiveClient, clientInputSchema, getClient, updateClient } from "@/lib/services/clients";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  return handle(async () => {
    const user = await requireUser(req);
    return json({ client: await getClient(user.id, (await ctx.params).id) });
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async () => {
    const user = await requireUser(req);
    const body = await parseBody(req, clientInputSchema);
    return json({ client: await updateClient(user.id, (await ctx.params).id, body) });
  });
}

/** Archive (the client's reminders must be deleted first). */
export async function DELETE(req: Request, ctx: Ctx) {
  return handle(async () => {
    const user = await requireUser(req);
    await archiveClient(user.id, (await ctx.params).id);
    return json({ ok: true });
  });
}
