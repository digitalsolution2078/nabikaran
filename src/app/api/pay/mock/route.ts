import { z } from "zod";
import { handle, json, parseBody, HttpError } from "@/lib/http";
import { env } from "@/lib/env";
import { getPaymentGateway } from "@/lib/payments";
import { MockGateway } from "@/lib/payments/mock";

/** Development-only: script the mock gateway's lookup result for a pidx. */
export async function POST(req: Request) {
  return handle(async () => {
    if (env.isProd) throw new HttpError(404, "Not found");
    const gw = getPaymentGateway();
    if (!(gw instanceof MockGateway)) throw new HttpError(400, "Mock gateway not active");
    const body = await parseBody(req, z.object({ pidx: z.string(), status: z.enum(["completed", "canceled", "pending", "expired"]), amountPaisa: z.number().int().optional() }));
    gw.settle(body.pidx, body.status, { amountPaisa: body.amountPaisa });
    return json({ ok: true, next: `/api/payments/mock/return?pidx=${encodeURIComponent(body.pidx)}` });
  });
}
