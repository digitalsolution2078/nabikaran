import { cookies } from "next/headers";
import { z } from "zod";
import { handle, json, parseBody, HttpError } from "@/lib/http";
import { assertSameOrigin, getCurrentUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { PREFS_COOKIE, encodePrefs } from "@/lib/i18n/prefs";

const schema = z.object({
  lang: z.enum(["ne", "en"]),
  date: z.enum(["BS", "AD"]),
  smsLanguage: z.enum(["en-NP", "ne-NP"]).optional(),
});

/**
 * Save display preferences. Guests: cookie only (mirrored to localStorage by
 * the client). Signed-in users: also stored on the profile so they follow the
 * user across devices.
 */
export async function POST(req: Request) {
  return handle(async () => {
    if (!(await assertSameOrigin())) throw new HttpError(403, "Cross-site request blocked", "csrf");
    const p = await parseBody(req, schema);
    const jar = await cookies();
    jar.set(PREFS_COOKIE, encodePrefs(p), { httpOnly: false, sameSite: "lax", secure: env.isProd, path: "/", maxAge: 365 * 24 * 3600 });
    const user = await getCurrentUser();
    if (user) {
      await getDb().query(
        "update users set ui_language = $2, date_format = $3, locale = coalesce($4, locale), updated_at = now() where id = $1",
        [user.id, p.lang, p.date, p.smsLanguage ?? null],
      );
    }
    return json({ ok: true, synced: Boolean(user) });
  });
}
