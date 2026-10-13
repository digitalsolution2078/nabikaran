import { z } from "zod";
import { handle, json, HttpError, limit, clientIp, requireSameOrigin } from "@/lib/http";
import { attachmentFromForm, customerReply } from "@/lib/services/support";

type Ctx = { params: Promise<{ token: string }> };

/** Visitor answers through their private ticket link. */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    await requireSameOrigin();
    await limit(`ip:${clientIp(req) ?? "unknown"}`, "support:guest-reply", 20, 3600);
    const token = z.string().min(20).max(64).regex(/^[A-Za-z0-9_-]+$/).parse((await ctx.params).token);
    const form = await req.formData().catch(() => {
      throw new HttpError(400, "Expected form data");
    });
    await customerReply({ token }, String(form.get("body") ?? ""), await attachmentFromForm(form));
    return json({ ok: true });
  });
}
