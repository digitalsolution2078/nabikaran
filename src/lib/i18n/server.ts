import { cookies } from "next/headers";
import { getCurrentUser, type SessionUser } from "../auth/session";
import { translate, type Lang, type MessageKey } from "./dict";
import type { Prefs } from "./format";
import { DEFAULT_PREFS, PREFS_COOKIE, decodePrefs } from "./prefs";

export interface RequestContext {
  user: SessionUser | null;
  prefs: Prefs;
  /** False only for a first-time guest who has not chosen language/calendar yet. */
  chosen: boolean;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

/** Server components: current user + effective display preferences. */
export async function getRequestContext(): Promise<RequestContext> {
  const [user, jar] = await Promise.all([getCurrentUser(), cookies()]);
  const cookiePrefs = decodePrefs(jar.get(PREFS_COOKIE)?.value);
  const prefs: Prefs = user ? { lang: user.uiLanguage, date: user.dateFormat } : (cookiePrefs ?? DEFAULT_PREFS);
  const lang: Lang = prefs.lang;
  return { user, prefs, chosen: Boolean(user || cookiePrefs), t: (key, vars) => translate(lang, key, vars) };
}
