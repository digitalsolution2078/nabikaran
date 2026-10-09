import { z } from "zod";
import { handle, requirePermission, HttpError } from "@/lib/http";
import { getReceipt } from "@/lib/services/manual-topups";

type Ctx = { params: Promise<{ id: string }> };

/** Admin-only receipt download, served inert (attachment + nosniff + sandbox CSP). */
export async function GET(req: Request, ctx: Ctx) {
  return handle(async () => {
    await requirePermission(req, "topups.decide");
    const { id } = await ctx.params;
    const r = await getReceipt(z.string().uuid().parse(id));
    if (!r) throw new HttpError(404, "No receipt", "not_found");
    const ext = r.contentType.split("/")[1];
    return new Response(new Uint8Array(r.bytes), {
      headers: {
        "content-type": r.contentType,
        "content-disposition": `inline; filename="receipt-${id.slice(0, 8)}.${ext}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        "cache-control": "private, no-store",
      },
    });
  });
}
