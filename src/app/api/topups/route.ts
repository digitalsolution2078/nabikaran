import { z } from "zod";
import { handle, json, parseBody, requireUser, limit } from "@/lib/http";
import { createCustomTopupOrder, createTopupOrder, listPacks } from "@/lib/services/payments";
import { startManualTopup } from "@/lib/services/manual-topups";
import { getSetting } from "@/lib/services/settings";

export async function GET(req: Request) {
  return handle(async () => {
    await requireUser(req);
    const [packs, topup, qr] = await Promise.all([listPacks(), getSetting("topup"), getSetting("manual_qr")]);
    return json({
      packs: packs.map((p) => ({ code: p.code, amountPaisa: Number(p.amount_paisa), credits: Number(p.credits) })),
      limits: topup,
      qrEnabled: qr.enabled,
    });
  });
}

const schema = z.union([
  z.object({ packCode: z.string().min(1).max(20) }),
  z.object({ amountNpr: z.number().int().positive(), method: z.enum(["khalti", "qr"]) }),
]);

/**
 * Start a top-up. Amounts are whole NPR validated against admin limits on the
 * server (1 credit = NPR 1). Khalti: returns a checkout URL. QR: creates a
 * manual request with a unique payment reference and returns its page.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    if (req.method === "POST") await limit(`user:${user.id}`, "topup:start", 10, 3600);
    const body = await parseBody(req, schema);
    if ("packCode" in body) return json(await createTopupOrder(user, body.packCode), { status: 201 });
    if (body.method === "khalti") return json(await createCustomTopupOrder(user, body.amountNpr), { status: 201 });
    const { request } = await startManualTopup(user.id, body.amountNpr);
    return json({ manualRequestId: request.id, reference: request.reference, next: `/wallet/topup/${request.id}` }, { status: 201 });
  });
}
