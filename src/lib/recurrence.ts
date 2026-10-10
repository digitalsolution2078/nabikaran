/**
 * Yearly repetition (birthdays, anniversaries, yearly renewals). Pure; used by
 * the server and the reminder form. A repeating reminder keeps the month and
 * day it was entered with (the "anchor", in AD or BS); each year it lands on
 * that day, clamped to the month's length (29 Feb → 28 Feb, BS day 32 → 31).
 */
import { adToBs, bsDaysInMonth, bsToAd, BS_MAX_YEAR } from "./bs-date";
import { kathmanduToUtc, utcToKathmandu, pad2, type LocalDate } from "./time";

export type Calendar = "AD" | "BS";

export interface Anchor {
  month: number;
  day: number;
}

const LOOSE_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/** Month/day from a YYYY-MM-DD input in either calendar (the year may be any birth year). */
export function anchorFromInput(raw: string): Anchor | null {
  const m = LOOSE_DATE.exec(raw.trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 32) return null;
  return { month, day };
}

export function anchorToString(a: Anchor): string {
  return `${pad2(a.month)}-${pad2(a.day)}`;
}

export function parseAnchor(s: string | null | undefined): Anchor | null {
  const m = /^(\d{2})-(\d{2})$/.exec(s ?? "");
  return m ? { month: Number(m[1]), day: Number(m[2]) } : null;
}

function daysInMonth(calendar: Calendar, year: number, month: number): number | null {
  if (calendar === "BS") return bsDaysInMonth(year, month);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The date in `year` for an anchor, clamped to the month length; null when the year is unsupported. */
export function occurrenceIn(calendar: Calendar, year: number, a: Anchor): LocalDate | null {
  const dim = daysInMonth(calendar, year, a.month);
  if (!dim) return null;
  if (calendar === "AD" && a.day > 31) return null;
  return { year, month: a.month, day: Math.min(a.day, dim) };
}

/** Current year in the given calendar at an instant (Nepal time). */
export function currentYear(calendar: Calendar, at: Date): number {
  const k = utcToKathmandu(at);
  return calendar === "BS" ? adToBs({ year: k.year, month: k.month, day: k.day }).year : k.year;
}

export interface Occurrence {
  /** YYYY-MM-DD in the input calendar. */
  raw: string;
  utc: Date;
}

/**
 * The first occurrence strictly after `after`, never earlier than `minYear`
 * (so a future first date is kept as entered). Returns null outside the
 * supported BS range.
 */
export function nextOccurrence(calendar: Calendar, anchor: Anchor, localTime: string, after: Date, minYear?: number): Occurrence | null {
  let year = Math.max(minYear ?? 0, currentYear(calendar, after) - 1);
  for (let i = 0; i < 4; i++, year++) {
    if (calendar === "BS" && year > BS_MAX_YEAR) return null;
    const d = occurrenceIn(calendar, year, anchor);
    if (!d) return null;
    const ad = calendar === "BS" ? bsToAd(d) : d;
    const utc = kathmanduToUtc(ad, localTime);
    if (utc.getTime() > after.getTime()) return { raw: `${d.year}-${pad2(d.month)}-${pad2(d.day)}`, utc };
  }
  return null;
}

/** Repeat every 1, 3 or 6 months (subscriptions). Yearly uses `nextOccurrence`. */
export const REPEAT_MONTHS = [1, 3, 6] as const;
export type RepeatMonths = (typeof REPEAT_MONTHS)[number];

/** Add `months` to a date in its calendar, keeping the anchor day (clamped to the month length). */
export function addMonths(calendar: Calendar, from: LocalDate, months: number, anchorDay: number): LocalDate | null {
  const idx = from.year * 12 + (from.month - 1) + months;
  const year = Math.floor(idx / 12);
  const month = (idx % 12) + 1;
  if (calendar === "BS" && year > BS_MAX_YEAR) return null;
  const dim = daysInMonth(calendar, year, month);
  if (!dim) return null;
  return { year, month, day: Math.min(anchorDay, dim) };
}

/**
 * The first date on or after `start` (stepping every `months`) that is strictly
 * after `after`. `start` is YYYY-MM-DD in the calendar; `anchorDay` defaults to
 * its day. Null if the date is invalid or runs past the supported BS range.
 */
export function nextEveryMonths(calendar: Calendar, start: string, localTime: string, months: number, after: Date, anchorDay?: number): Occurrence | null {
  const m = LOOSE_DATE.exec(start.trim());
  if (!m) return null;
  let d: LocalDate | null = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const day = anchorDay ?? d.day;
  const dim = daysInMonth(calendar, d.year, d.month);
  if (!dim || d.month < 1 || d.month > 12 || d.day < 1 || d.day > dim) return null;
  for (let i = 0; i < 1200 && d; i++) {
    const ad = calendar === "BS" ? bsToAd(d) : d;
    const utc = kathmanduToUtc(ad, localTime);
    if (utc.getTime() > after.getTime()) return { raw: `${d.year}-${pad2(d.month)}-${pad2(d.day)}`, utc };
    d = addMonths(calendar, d, months, day);
  }
  return null;
}
