/**
 * Bikram Sambat (BS) <-> Gregorian (AD) conversion.
 *
 * Wraps `nepali-date-converter` (supported range 2000-01-01 .. 2090-12-30 BS)
 * and adds strict validation: the upstream constructor silently rolls over
 * out-of-range days (e.g. Baisakh 33 -> Jestha 2), which must never happen
 * for a renewal expiry. The canonical Gregorian value is what we persist and
 * schedule against; BS is an input/display convenience only.
 */
import * as ndc from "nepali-date-converter";
import type { LocalDate } from "./time";

type NepaliDateCtor = new (year: number, monthIndex: number, day: number) => {
  toJsDate(): Date;
  getYear(): number;
  getMonth(): number;
  getDate(): number;
};

const mod = ndc as unknown as { default?: NepaliDateCtor; dateConfigMap?: Record<string, Record<string, number>> } & NepaliDateCtor;
const NepaliDate: NepaliDateCtor = (mod.default ?? mod) as NepaliDateCtor;
const dateConfigMap: Record<string, Record<string, number>> =
  mod.dateConfigMap ?? (mod.default as unknown as { dateConfigMap?: Record<string, Record<string, number>> })?.dateConfigMap ?? {};

export const BS_MONTHS_EN = [
  "Baisakh", "Jestha", "Asar", "Shrawan", "Bhadra", "Aswin",
  "Kartik", "Mangsir", "Poush", "Magh", "Falgun", "Chaitra",
] as const;

export const BS_MONTHS_NE = [
  "बैशाख", "जेठ", "असार", "श्रावण", "भदौ", "असोज",
  "कार्तिक", "मंसिर", "पुष", "माघ", "फाल्गुन", "चैत",
] as const;

export const BS_MIN_YEAR = 2000;
export const BS_MAX_YEAR = 2090;

export function bsDaysInMonth(year: number, month: number): number | null {
  const cfg = dateConfigMap[String(year)];
  if (!cfg) return null;
  const name = BS_MONTHS_EN[month - 1];
  if (!name) return null;
  const n = cfg[name];
  return typeof n === "number" ? n : null;
}

export function isValidBsDate(d: LocalDate): boolean {
  if (!Number.isInteger(d.year) || !Number.isInteger(d.month) || !Number.isInteger(d.day)) return false;
  if (d.year < BS_MIN_YEAR || d.year > BS_MAX_YEAR) return false;
  if (d.month < 1 || d.month > 12) return false;
  const dim = bsDaysInMonth(d.year, d.month);
  return dim !== null && d.day >= 1 && d.day <= dim;
}

/** Convert a BS calendar date to the Gregorian calendar date. Throws on invalid input. */
export function bsToAd(d: LocalDate): LocalDate {
  if (!isValidBsDate(d)) {
    throw new Error(`Invalid BS date ${d.year}-${d.month}-${d.day} (supported ${BS_MIN_YEAR}..${BS_MAX_YEAR})`);
  }
  const js = new NepaliDate(d.year, d.month - 1, d.day).toJsDate();
  // The library builds a local-time JS Date; read local components back.
  return { year: js.getFullYear(), month: js.getMonth() + 1, day: js.getDate() };
}

/** Convert a Gregorian calendar date to BS. Throws when outside the supported range. */
export function adToBs(d: LocalDate): LocalDate {
  const probe = new Date(d.year, d.month - 1, d.day, 12, 0, 0);
  // Constructor with a Date accepts any; range check happens in conversion.
  const NepaliDateFromDate = NepaliDate as unknown as new (v: Date) => { getYear(): number; getMonth(): number; getDate(): number };
  const n = new NepaliDateFromDate(probe);
  const out = { year: n.getYear(), month: n.getMonth() + 1, day: n.getDate() };
  if (!isValidBsDate(out)) throw new Error("Gregorian date outside supported BS range");
  return out;
}

const BS_INPUT_RE = /^(\d{4})[-/ ](\d{1,2})[-/ ](\d{1,2})$/;

export function parseBsInput(value: string): LocalDate | null {
  const m = BS_INPUT_RE.exec(value.trim());
  if (!m) return null;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  return isValidBsDate(d) ? d : null;
}

export function formatBs(d: LocalDate, lang: "ne" | "en" = "ne"): string {
  const months = lang === "ne" ? BS_MONTHS_NE : BS_MONTHS_EN;
  return `${d.year} ${months[d.month - 1]} ${d.day}`;
}
