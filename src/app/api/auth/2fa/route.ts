import { z } from "zod";
import { clientIp, handle, json, limit, parseBody, requireSameOrigin, HttpError } from "@/lib/http";
import { clearPendingTwoFactor, getPendingTwoFactor, setSessionCookie } from "@/lib/auth/session";
import { verifySecondFactor } from "@/lib/services/two-factor";

/** Second sign-in step: the authenticator-app code (or a recovery code). */
export async function POST(req: Request) {
  return handle(async () => {
    await requireSameOrigin();
    const userId = await getPendingTwoFactor();
    if (!userId) throw new HttpError(401, "Sign-in expired. Start again.", "pending_expired");
    await limit(`ip:${clientIp(req) ?? "unknown"}`, "2fa:verify", 30, 900);
    await limit(`user:${userId}`, "2fa:verify", 8, 900);
    const { code } = await parseBody(req, z.object({ code: z.string().trim().min(6).max(20) }));
    const how = await verifySecondFactor(userId, code);
    await clearPendingTwoFactor();
    await setSessionCookie(userId);
    return json({ ok: true, method: how, next: "/dashboard" });
  });
}
