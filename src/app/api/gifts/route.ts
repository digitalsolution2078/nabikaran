import { z } from "zod";
import { handle, json, parseBody, requireUser, limit } from "@/lib/http";
import { listMyGiftCards } from "@/lib/services/credit-codes";
import { startManualTopup } from "@/lib/services/manual-topups";

export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    return json({ gifts: await listMyGiftCards(user.id) });
  });
}

/** Buy a gift card: starts a QR payment; the code works only once that payment is confirmed. */
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "gift:start", 10, 3600);
    const body = await parseBody(req, z.object({ amountNpr: z.number().int().positive(), toName: z.string().max(60).nullable().default(null), message: z.string().max(200).nullable().default(null) }));
    const { request } = await startManualTopup(user.id, body.amountNpr, undefined, { toName: body.toName, message: body.message });
    return json({ manualRequestId: request.id, reference: request.reference, next: `/wallet/topup/${request.id}` }, { status: 201 });
  });
}
