import { z } from "zod";
import { handle, json, HttpError, limit, requireUser } from "@/lib/http";
import { attachmentFromForm, customerReply } from "@/lib/services/support";

type Ctx = { params: Promise<{ id: string }> };

/** Signed-in customer answers their ticket (multipart: body, attachment?). */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "support:reply", 30, 3600);
    const ticketId = z.string().uuid().parse((await ctx.params).id);
    const form = await req.formData().catch(() => {
      throw new HttpError(400, "Expected form data");
    });
    await customerReply({ userId: user.id, ticketId }, String(form.get("body") ?? ""), await attachmentFromForm(form));
    return json({ ok: true });
  });
}
