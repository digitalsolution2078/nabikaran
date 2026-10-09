import { adToBs, BS_MONTHS_EN, BS_MONTHS_NE } from "../bs-date";
import { utcToKathmandu } from "../time";
import type { Lang } from "./dict";

/** Isomorphic (server + client) date formatting in Nepal time. */
export type DateFormat = "BS" | "AD";
export interface Prefs {
  lang: Lang;
  date: DateFormat;
}

const DEVANAGARI_DIGITS = "०१२३४५६७८९";
export function nepaliDigits(s: string | number): string {
  return String(s).replace(/[0-9]/g, (d) => DEVANAGARI_DIGITS[Number(d)]);
}

export function localizeNumber(n: number | string, lang: Lang): string {
  const s = typeof n === "number" ? n.toLocaleString("en-IN") : n;
  return lang === "ne" ? nepaliDigits(s) : s;
}

const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_NE = ["आइतबार", "सोमबार", "मंगलबार", "बुधबार", "बिहीबार", "शुक्रबार", "शनिबार"];
const MONTHS_AD_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_AD_NE = ["जनवरी", "फेब्रुअरी", "मार्च", "अप्रिल", "मे", "जुन", "जुलाई", "अगस्ट", "सेप्टेम्बर", "अक्टोबर", "नोभेम्बर", "डिसेम्बर"];

function toDate(v: Date | string): Date {
  return typeof v === "string" ? new Date(v) : v;
}

/** Calendar date in Nepal time, in the user's calendar and language. */
export function formatDate(v: Date | string, p: Prefs, opts: { short?: boolean } = {}): string {
  const k = utcToKathmandu(toDate(v));
  if (p.date === "BS") {
    try {
      const b = adToBs({ year: k.year, month: k.month, day: k.day });
      if (p.lang === "ne") return `${nepaliDigits(b.year)} ${BS_MONTHS_NE[b.month - 1]} ${nepaliDigits(b.day)}`;
      return `${b.day} ${BS_MONTHS_EN[b.month - 1]} ${b.year}`;
    } catch {
      // outside the supported BS range: fall through to AD
    }
  }
  const months = p.lang === "ne" ? MONTHS_AD_NE : MONTHS_AD_EN;
  const m = opts.short && p.lang === "en" ? months[k.month - 1].slice(0, 3) : months[k.month - 1];
  return p.lang === "ne" ? `${nepaliDigits(k.year)} ${m} ${nepaliDigits(k.day)}` : `${k.day} ${m} ${k.year}`;
}

export function formatTime(v: Date | string, p: Prefs): string {
  const k = utcToKathmandu(toDate(v));
  const h12 = k.hour % 12 === 0 ? 12 : k.hour % 12;
  const mm = String(k.minute).padStart(2, "0");
  if (p.lang === "ne") return `${nepaliDigits(h12)}:${nepaliDigits(mm)} ${k.hour < 12 ? "बिहान" : k.hour < 17 ? "दिउँसो" : "बेलुका"}`;
  return `${h12}:${mm} ${k.hour < 12 ? "AM" : "PM"}`;
}

export function formatDateTime(v: Date | string, p: Prefs): string {
  return `${formatDate(v, p)}, ${formatTime(v, p)}`;
}

export function weekday(v: Date | string, p: Prefs): string {
  const d = toDate(v);
  const k = utcToKathmandu(d);
  const dow = new Date(Date.UTC(k.year, k.month - 1, k.day)).getUTCDay();
  return (p.lang === "ne" ? WEEKDAYS_NE : WEEKDAYS_EN)[dow];
}

/** Header clock text, e.g. "Friday, 9 October 2026 | 7:40 PM NPT". */
export function clockText(now: Date, p: Prefs): { day: string; date: string; time: string } {
  return { day: weekday(now, p), date: formatDate(now, p), time: `${formatTime(now, p)} ${p.lang === "ne" ? "NPT" : "NPT"}` };
}

/** The other calendar, for showing both (e.g. under a BS date show the AD date). */
export function otherCalendar(v: Date | string, p: Prefs): string {
  return formatDate(v, { ...p, date: p.date === "BS" ? "AD" : "BS" });
}

export function daysUntil(v: Date | string, now: Date = new Date()): number {
  const a = utcToKathmandu(toDate(v));
  const b = utcToKathmandu(now);
  return Math.round((Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / 86_400_000);
}

/** "30 days before" / "३० दिन अगाडि" — localized reminder offset label. */
export function offsetLabel(offsetMinutes: number, lang: Lang): string {
  if (offsetMinutes === 0) return lang === "ne" ? "म्याद सकिने दिन" : "on expiry";
  const d = Math.floor(offsetMinutes / 1440);
  const h = Math.floor((offsetMinutes % 1440) / 60);
  const m = offsetMinutes % 60;
  const parts: string[] = [];
  if (lang === "ne") {
    if (d) parts.push(`${nepaliDigits(d)} दिन`);
    if (h) parts.push(`${nepaliDigits(h)} घण्टा`);
    if (m) parts.push(`${nepaliDigits(m)} मिनेट`);
    return `${parts.join(" ")} अगाडि`;
  }
  if (d) parts.push(`${d} day${d === 1 ? "" : "s"}`);
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  return `${parts.join(" ")} before`;
}
