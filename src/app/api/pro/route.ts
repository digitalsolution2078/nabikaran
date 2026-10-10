import { z } from "zod";
import { handle, json, parseBody, requireUser, limit } from "@/lib/http";
import { allowCreditsForWaiting, buyPro, getPlanState, setProPrefs, startTrial } from "@/lib/services/plans";

export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    return json(await getPlanState(user.id));
  });
}

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("trial") }),
  z.object({ action: z.literal("buy"), idempotencyKey: z.string().min(8).max(64) }),
  z.object({ action: z.literal("allow_credits") }),
  z.object({ action: z.literal("prefs"), creditFallback: z.boolean().optional(), digest: z.enum(["off", "weekly", "monthly"]).optional() }),
]);

export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "pro:action", 10, 3600);
    const body = await parseBody(req, schema);
    if (body.action === "trial") return json({ state: await startTrial(user.id) });
    if (body.action === "allow_credits") return json(await allowCreditsForWaiting(user.id));
    if (body.action === "prefs") return json(await setProPrefs(user.id, { creditFallback: body.creditFallback, digest: body.digest }));
    const r = await buyPro(user.id, body.idempotencyKey);
    return json(r, { status: r.replayed ? 200 : 201 });
  });
}
