import { z } from "zod";
import { handle, json, HttpError, requirePermission } from "@/lib/http";
import { attachmentFromForm, staffAction } from "@/lib/services/support";

type Ctx = { params: Promise<{ id: string }> };

/** Staff: reply, internal note, status, assign, priority. JSON or multipart (reply/note with a file). */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const admin = await requirePermission(req, "support.manage");
    const ticketId = z.string().uuid().parse((await ctx.params).id);
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("multipart/form-data")) {
      const form = await req.formData().catch(() => {
        throw new HttpError(400, "Expected form data");
      });
      const action = String(form.get("action") ?? "reply");
      const body = String(form.get("body") ?? "");
      const status = String(form.get("status") ?? "waiting_customer");
      const ticket = await staffAction(admin, ticketId, (action === "note" ? { action: "note", body } : { action: "reply", body, status }) as never, await attachmentFromForm(form));
      return json({ ticket });
    }
    const ticket = await staffAction(admin, ticketId, await req.json());
    return json({ ticket });
  });
}
