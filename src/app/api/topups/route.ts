import { z } from "zod";
import { handle, json, parseBody, requireUser } from "@/lib/http";
import { createTopupOrder, listPacks } from "@/lib/services/payments";

export async function GET(req: Request) {
  return handle(async () => {
    await requireUser(req);
    const packs = await listPacks();
    return json({ packs: packs.map((p) => ({ code: p.code, amountPaisa: Number(p.amount_paisa), credits: Number(p.credits) })) });
  });
}

/** Create a server-side order from an offered pack and start checkout. */
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    const { packCode } = await parseBody(req, z.object({ packCode: z.string().min(1).max(20) }));
    return json(await createTopupOrder(user, packCode), { status: 201 });
  });
}
