import { z } from "zod";
import { clientIp, handle, json, parseBody, requireUser, limit } from "@/lib/http";
import { redeemCode } from "@/lib/services/credit-codes";

/** Redeem a coupon code or gift card into the signed-in customer's wallet. */
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    // Every attempt counts, so codes cannot be guessed.
    await limit(`user:${user.id}`, "code:redeem", 10, 3600);
    await limit(`ip:${clientIp(req) ?? "unknown"}`, "code:redeem", 30, 3600);
    const { code } = await parseBody(req, z.object({ code: z.string().trim().min(4).max(40) }));
    return json(await redeemCode(user.id, code));
  });
}
