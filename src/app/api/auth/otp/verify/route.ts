import { cookies } from "next/headers";
import { z } from "zod";
import { handle, json, parseBody, limit, clientIp } from "@/lib/http";
import { verifyOtp } from "@/lib/auth/otp";
import { setSessionCookie } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { PREFS_COOKIE, decodePrefs, encodePrefs } from "@/lib/i18n/prefs";
import { REFERRAL_COOKIE, attachReferral } from "@/lib/services/referrals";

const schema = z.object({ phone: z.string().min(7).max(20), code: z.string().length(6), ref: z.string().max(12).optional() });

export async function POST(req: Request) {
  return handle(async () => {
    await limit(`ip:${clientIp(req) ?? "unknown"}`, "otp:verify", 30, 600);
    const { phone, code, ref } = await parseBody(req, schema);
    const { userId, isNew } = await verifyOtp(phone, code);
    await setSessionCookie(userId);
    const jar0 = await cookies();
    if (isNew) {
      // A new account opened from an invite link (cookie) or ?ref= on the sign-in page.
      await attachReferral(userId, jar0.get(REFERRAL_COOKIE)?.value ?? ref).catch((e) => console.error("[referral] attach failed", e));
    }
    if (jar0.get(REFERRAL_COOKIE)) jar0.delete(REFERRAL_COOKIE);
    // Preference sync: a choice made as a guest wins for new accounts; otherwise the
    // profile wins and is copied into the cookie for this browser.
    const jar = await cookies();
    const guest = decodePrefs(jar.get(PREFS_COOKIE)?.value);
    const db = getDb();
    if (guest && isNew) {
      await db.query("update users set ui_language = $2, date_format = $3 where id = $1", [userId, guest.lang, guest.date]);
    } else {
      const { rows } = await db.query<{ ui_language: "ne" | "en"; date_format: "BS" | "AD" }>("select ui_language, date_format from users where id = $1", [userId]);
      if (rows[0]) jar.set(PREFS_COOKIE, encodePrefs({ lang: rows[0].ui_language, date: rows[0].date_format }), { httpOnly: false, sameSite: "lax", secure: env.isProd, path: "/", maxAge: 365 * 24 * 3600 });
    }
    return json({ ok: true, isNew, next: "/dashboard" });
  });
}
