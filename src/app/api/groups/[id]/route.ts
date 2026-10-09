import { z } from "zod";
import { handle, json, parseBody, requirePrincipal, limit } from "@/lib/http";
import { deleteGroup, groupInputSchema, updateGroup } from "@/lib/services/groups";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    await limit(`user:${principal.userId}`, "group:write", 30, 60);
    const { id } = await params;
    const body = await parseBody(req, groupInputSchema);
    return json({ group: await updateGroup(principal, id, body) });
  });
}

const deleteSchema = z.object({ cancelReminders: z.boolean().optional() });

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    await limit(`user:${principal.userId}`, "group:write", 30, 60);
    const { id } = await params;
    const body = await parseBody(req, deleteSchema).catch(() => ({ cancelReminders: false }));
    return json(await deleteGroup(principal, id, { cancelReminders: Boolean(body.cancelReminders) }));
  });
}
