import { z } from "zod";
import { handle, json, parseBody } from "@/lib/http";
import { verifyOtp } from "@/lib/auth/otp";
import { setSessionCookie } from "@/lib/auth/session";

const schema = z.object({ phone: z.string().min(7).max(20), code: z.string().length(6) });

export async function POST(req: Request) {
  return handle(async () => {
    const { phone, code } = await parseBody(req, schema);
    const { userId, isNew } = await verifyOtp(phone, code);
    await setSessionCookie(userId);
    return json({ ok: true, isNew, next: isNew ? "/onboarding" : "/dashboard" });
  });
}
