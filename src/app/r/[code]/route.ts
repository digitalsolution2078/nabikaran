import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { REFERRAL_COOKIE, normalizeCode } from "@/lib/services/referrals";

/** nabikaran.org/r/CODE — remember the inviter for 30 days, then go to sign-in. */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = normalizeCode((await params).code);
  const base = env.appUrl.replace(/\/$/, "") || new URL(req.url).origin;
  const res = NextResponse.redirect(`${base}/login${code ? `?ref=${code}` : ""}`, 302);
  if (code) res.cookies.set(REFERRAL_COOKIE, code, { httpOnly: true, sameSite: "lax", secure: env.isProd, path: "/", maxAge: 30 * 24 * 3600 });
  return res;
}
