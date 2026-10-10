import { cookies } from "next/headers";
import { z } from "zod";
import { handle, json, parseBody, limit, clientIp, HttpError } from "@/lib/http";
import { PinError, verifyPinLogin } from "@/lib/auth/pin";
import { setSessionCookie } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { normalizeNepalPhone } from "@/lib/phone";
import { PREFS_COOKIE, encodePrefs } from "@/lib/i18n/prefs";

const schema = z.object({ phone: z.string().min(7).max(20), pin: z.string().min(4).max(6) });

/** Sign in with mobile + PIN: no SMS is sent, so no sign-in fee. */
export async function POST(req: Request) {
  return handle(async () => {
    await limit(`ip:${clientIp(req) ?? "unknown"}`, "pin:login", 20, 600);
    const { phone, pin } = await parseBody(req, schema);
    await limit(`phone:${normalizeNepalPhone(phone) ?? "invalid"}`, "pin:login", 10, 900);
    let userId: string;
    try {
      ({ userId } = await verifyPinLogin(phone, pin));
    } catch (e) {
      if (e instanceof PinError) throw new HttpError(e.code === "pin_disabled" ? 403 : 401, e.message, e.code);
      throw e;
    }
    await setSessionCookie(userId);
    const { rows } = await getDb().query<{ ui_language: "ne" | "en"; date_format: "BS" | "AD" }>("select ui_language, date_format from users where id = $1", [userId]);
    if (rows[0]) (await cookies()).set(PREFS_COOKIE, encodePrefs({ lang: rows[0].ui_language, date: rows[0].date_format }), { httpOnly: false, sameSite: "lax", secure: env.isProd, path: "/", maxAge: 365 * 24 * 3600 });
    return json({ ok: true, next: "/dashboard" });
  });
}
