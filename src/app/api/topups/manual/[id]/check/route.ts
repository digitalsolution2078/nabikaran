import { z } from "zod";
import { handle, json, requireUser, limit } from "@/lib/http";
import { checkGatewayTopup } from "@/lib/services/manual-topups";

type Ctx = { params: Promise<{ id: string }> };

/** Customer's QR page polls this; the server asks Fonepay and credits the wallet once paid. */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "topup:check", 40, 60);
    const { id } = await ctx.params;
    const r = await checkGatewayTopup(z.string().uuid().parse(id), user.id);
    return json({ status: r.status });
  });
}
