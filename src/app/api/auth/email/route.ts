import { cookies } from "next/headers";
import { z } from "zod";
import { handle, json, parseBody, limit, clientIp } from "@/lib/http";
import { requestEmailLogin, verifyEmailLogin } from "@/lib/services/email-auth";
import { setSessionCookie } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { PREFS_COOKIE, encodePrefs } from "@/lib/i18n/prefs";

/** Pro: email a sign-in code. Same answer whether or not the email is an account. */
export async function POST(req: Request) {
  return handle(async () => {
    await limit(`ip:${clientIp(req) ?? "unknown"}`, "email:login", 10, 900);
    const { email } = await parseBody(req, z.object({ email: z.string().max(120) }));
    await limit(`email:${email.trim().toLowerCase()}`, "email:login", 5, 900);
    const r = await requestEmailLogin(email);
    return json({ sent: true, ...r });
  });
}

/** Pro: sign in with the emailed code. */
export async function PUT(req: Request) {
  return handle(async () => {
    await limit(`ip:${clientIp(req) ?? "unknown"}`, "email:login-verify", 20, 900);
    const { email, code } = await parseBody(req, z.object({ email: z.string().max(120), code: z.string().max(10) }));
    await limit(`email:${email.trim().toLowerCase()}`, "email:login-verify", 10, 900);
    const userId = await verifyEmailLogin(email, code);
    await setSessionCookie(userId);
    const { rows } = await getDb().query<{ ui_language: "ne" | "en"; date_format: "BS" | "AD" }>("select ui_language, date_format from users where id = $1", [userId]);
    if (rows[0]) (await cookies()).set(PREFS_COOKIE, encodePrefs({ lang: rows[0].ui_language, date: rows[0].date_format }), { httpOnly: false, sameSite: "lax", secure: env.isProd, path: "/", maxAge: 365 * 24 * 3600 });
    return json({ ok: true, next: "/dashboard" });
  });
}
