import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { addNote } from "@/lib/services/admin-console";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const admin = await requirePermission(req, "notes.write");
    const userId = z.string().uuid().parse((await ctx.params).id);
    const { body } = await parseBody(req, z.object({ body: z.string().min(2).max(2000) }));
    return json({ ok: true, id: await addNote(admin.id, userId, body) }, { status: 201 });
  });
}
