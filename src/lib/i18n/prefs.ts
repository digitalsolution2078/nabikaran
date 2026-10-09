import type { Lang } from "./dict";
import type { DateFormat, Prefs } from "./format";

/**
 * Display preferences. Guests: `nb_prefs` cookie (readable by the server so
 * the first render is already in the right language — no hydration flicker)
 * mirrored in localStorage. Signed-in users: users.ui_language/date_format,
 * synchronised on login and on every change.
 */
export const PREFS_COOKIE = "nb_prefs";
export const PREFS_STORAGE_KEY = "nabikaran.prefs";
export const DEFAULT_PREFS: Prefs = { lang: "ne", date: "BS" };

export function isLang(v: unknown): v is Lang {
  return v === "ne" || v === "en";
}
export function isDateFormat(v: unknown): v is DateFormat {
  return v === "BS" || v === "AD";
}

export function encodePrefs(p: Prefs): string {
  return `${p.lang}.${p.date}`;
}

export function decodePrefs(raw: string | null | undefined): Prefs | null {
  if (!raw) return null;
  const [lang, date] = raw.split(".");
  return isLang(lang) && isDateFormat(date) ? { lang, date } : null;
}
