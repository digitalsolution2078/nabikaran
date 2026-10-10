import { z } from "zod";
import { handle, json, parseBody, requireUser, limit } from "@/lib/http";
import { buyPro, getPlanState, startTrial } from "@/lib/services/plans";

export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    return json(await getPlanState(user.id));
  });
}

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("trial") }),
  z.object({ action: z.literal("buy"), idempotencyKey: z.string().min(8).max(64) }),
]);

export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "pro:action", 10, 3600);
    const body = await parseBody(req, schema);
    if (body.action === "trial") return json({ state: await startTrial(user.id) });
    const r = await buyPro(user.id, body.idempotencyKey);
    return json(r, { status: r.replayed ? 200 : 201 });
  });
}
