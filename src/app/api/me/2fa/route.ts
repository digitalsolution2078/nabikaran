import { z } from "zod";
import { handle, json, limit, parseBody, requireUser } from "@/lib/http";
import { beginSetup, confirmSetup, disableTwoFactor, regenerateRecoveryCodes, twoFactorStatus } from "@/lib/services/two-factor";

export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    return json(await twoFactorStatus(user.id));
  });
}

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setup") }),
  z.object({ action: z.literal("confirm"), code: z.string().trim().length(6) }),
  z.object({ action: z.literal("disable"), code: z.string().trim().min(6).max(20) }),
  z.object({ action: z.literal("recovery"), code: z.string().trim().length(6) }),
]);

export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "2fa:manage", 20, 900);
    const body = await parseBody(req, schema);
    if (body.action === "setup") return json(await beginSetup(user.id));
    if (body.action === "confirm") return json(await confirmSetup(user.id, body.code));
    if (body.action === "recovery") return json(await regenerateRecoveryCodes(user.id, body.code));
    await disableTwoFactor(user.id, body.code);
    return json(await twoFactorStatus(user.id));
  });
}
