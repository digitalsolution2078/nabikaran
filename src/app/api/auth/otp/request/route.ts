import { z } from "zod";
import { handle, json, parseBody, clientIp } from "@/lib/http";
import { requestOtp } from "@/lib/auth/otp";

const schema = z.object({ phone: z.string().min(7).max(20) });

export async function POST(req: Request) {
  return handle(async () => {
    const { phone } = await parseBody(req, schema);
    const r = await requestOtp({ phone, ip: clientIp(req), userAgent: req.headers.get("user-agent") });
    return json({ ok: true, phone: r.phoneE164, ...(r.devCode ? { devCode: r.devCode } : {}) });
  });
}
