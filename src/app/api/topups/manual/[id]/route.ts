import { z } from "zod";
import { handle, json, requireUser, HttpError } from "@/lib/http";
import { cancelManualTopup, submitManualTopup } from "@/lib/services/manual-topups";

type Ctx = { params: Promise<{ id: string }> };

/** Customer submits payment details (multipart: txnRef, note?, receipt?). */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const user = await requireUser(req);
    const { id } = await ctx.params;
    const requestId = z.string().uuid().parse(id);
    const form = await req.formData().catch(() => {
      throw new HttpError(400, "Expected form data");
    });
    const txn = String(form.get("txnRef") ?? "");
    const note = form.get("note");
    const file = form.get("receipt");
    let receipt: { contentType: string; bytes: Buffer } | null = null;
    if (file && typeof file === "object" && "arrayBuffer" in file && (file as File).size > 0) {
      const f = file as File;
      receipt = { contentType: f.type, bytes: Buffer.from(await f.arrayBuffer()) };
    }
    const r = await submitManualTopup(user.id, requestId, { payerTxnRef: txn, payerNote: typeof note === "string" ? note : null, receipt });
    return json({ request: r });
  });
}

export async function DELETE(req: Request, ctx: Ctx) {
  return handle(async () => {
    const user = await requireUser(req);
    const { id } = await ctx.params;
    await cancelManualTopup(user.id, z.string().uuid().parse(id));
    return json({ ok: true });
  });
}
