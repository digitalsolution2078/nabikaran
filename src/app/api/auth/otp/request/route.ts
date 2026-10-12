import { z } from "zod";
import { handle, json, parseBody, clientIp, limit, requireSameOrigin } from "@/lib/http";
import { requestOtp } from "@/lib/auth/otp";
import { normalizeNepalPhone } from "@/lib/phone";
import { env } from "@/lib/env";

const schema = z.object({ phone: z.string().min(7).max(20) });

export async function POST(req: Request) {
  return handle(async () => {
    await requireSameOrigin();
    const { phone } = await parseBody(req, schema);
    // Atomic limits (the count inside requestOtp alone can be raced by parallel requests).
    await limit(`ip:${clientIp(req) ?? "unknown"}`, "otp:request", env.otp.perIpPerHour, 3600);
    await limit(`phone:${normalizeNepalPhone(phone) ?? "invalid"}`, "otp:request", env.otp.perPhonePer15Min, 900);
    const r = await requestOtp({ phone, ip: clientIp(req), userAgent: req.headers.get("user-agent") });
    return json({ ok: true, phone: r.phoneE164, ...(r.devCode ? { devCode: r.devCode } : {}) });
  });
}
