/**
 * Bulk reminder import: CSV / pasted-spreadsheet parsing and row validation.
 * Pure (no I/O) so the same rules run in tests and on the server.
 *
 * Minimal file:            name,date
 *                          Ram Sharma,2052-04-15
 * Optional columns:        calendar (AD/BS), category, time (HH:MM),
 *                          remind (days before, e.g. "7;1;0"), repeat (yes/no),
 *                          notes, for (family member)
 */
import { CATEGORIES, CATEGORY_INFO, type Category } from "./categories";
import { parseIsoDate } from "./time";
import { parseBsInput } from "./bs-date";
import { anchorFromInput } from "./recurrence";
import { MAX_REMINDERS_PER_CYCLE } from "./scheduler";

export const MAX_IMPORT_ROWS = 300;
export const MAX_IMPORT_BYTES = 200_000;

export interface ImportDefaults {
  calendar: "AD" | "BS";
  category: Category;
  localTime: string;
  offsetsDays: number[];
  repeatYearly: boolean;
}

export type RowError =
  | "missing_name" | "name_too_long" | "missing_date" | "bad_date" | "bad_calendar"
  | "bad_category" | "bad_time" | "bad_remind" | "bad_repeat";

export interface ParsedRow {
  /** 1-based line number in the file (for messages). */
  line: number;
  label: string;
  date: string;
  calendar: "AD" | "BS";
  category: Category;
  localTime: string;
  offsets: number[];
  repeatYearly: boolean;
  notes: string | null;
  familyMemberLabel: string | null;
  errors: RowError[];
  duplicate: boolean;
}

export interface ParseResult {
  rows: ParsedRow[];
  headerDetected: boolean;
  tooMany: boolean;
}

/** RFC 4180 CSV with auto-detected delimiter (comma, semicolon or tab from a spreadsheet paste). */
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const first = src.split("\n", 1)[0] ?? "";
  const delim = first.includes("\t") ? "\t" : !first.includes(",") && first.includes(";") ? ";" : ",";
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); out.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); out.push(row); }
  return out.map((r) => r.map((f) => f.trim())).filter((r) => r.some((f) => f !== ""));
}

const NE_DIGITS = "०१२३४५६७८९";
export function latinDigits(s: string): string {
  return s.replace(/[०-९]/g, (d) => String(NE_DIGITS.indexOf(d)));
}

const HEADER_ALIASES: Record<string, string[]> = {
  label: ["name", "label", "naam", "person", "title", "नाम"],
  date: ["date", "dob", "birthday", "birth date", "birthdate", "date of birth", "expiry", "expiry date", "miti", "मिति", "जन्म मिति"],
  calendar: ["calendar", "cal", "ad/bs", "bs/ad"],
  category: ["category", "type"],
  time: ["time", "samay", "समय"],
  remind: ["remind", "remind days", "remind_days", "days before", "days_before", "reminders"],
  repeat: ["repeat", "yearly", "repeat yearly", "repeat_yearly", "every year"],
  notes: ["notes", "note", "remarks"],
  for: ["for", "family", "member", "family member"],
};

function headerMap(cells: string[]): Record<string, number> | null {
  const map: Record<string, number> = {};
  cells.forEach((c, i) => {
    const k = c.toLowerCase().replace(/\s+/g, " ").trim();
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) if (aliases.includes(k) && map[key] === undefined) map[key] = i;
  });
  return map.label !== undefined && map.date !== undefined ? map : null;
}

/** "2052/4/5", "2052.04.05", "२०५२-०४-०५" → "2052-04-05"; anything else unchanged. */
export function normalizeDate(raw: string): string {
  const s = latinDigits(raw).trim();
  const m = /^(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})$/.exec(s);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : s;
}

function categoryFrom(v: string): Category | null {
  const k = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((CATEGORIES as readonly string[]).includes(k)) return k as Category;
  for (const [key, info] of Object.entries(CATEGORY_INFO)) if (info.en.toLowerCase() === v.trim().toLowerCase() || info.ne === v.trim()) return key as Category;
  return null;
}

function yesNo(v: string): boolean | null {
  const k = v.trim().toLowerCase();
  if (["yes", "y", "true", "1", "haa", "ho", "हो", "हुन्छ"].includes(k)) return true;
  if (["no", "n", "false", "0", "hoina", "होइन"].includes(k)) return false;
  return null;
}

function validDate(date: string, calendar: "AD" | "BS", yearly: boolean): boolean {
  if (yearly) {
    const a = anchorFromInput(date);
    if (!a) return false;
    if (calendar === "AD") return a.day <= new Date(Date.UTC(2024, a.month, 0)).getUTCDate(); // leap year allows 29 Feb
    return a.day <= 32;
  }
  return calendar === "BS" ? parseBsInput(date) !== null : parseIsoDate(date) !== null;
}

export function parseImport(text: string, defaults: ImportDefaults): ParseResult {
  const table = parseDelimited(text);
  const header = table.length ? headerMap(table[0]) : null;
  const body = header ? table.slice(1) : table;
  const col = header ?? { label: 0, date: 1 };
  const tooMany = body.length > MAX_IMPORT_ROWS;
  const seen = new Map<string, number>();
  const rows = body.slice(0, MAX_IMPORT_ROWS).map((cells, idx): ParsedRow => {
    const get = (k: string) => (col[k] !== undefined ? (cells[col[k]] ?? "").trim() : "");
    const errors: RowError[] = [];
    const label = get("label").replace(/\s+/g, " ");
    if (!label) errors.push("missing_name");
    else if (label.length > 80) errors.push("name_too_long");

    let calendar = defaults.calendar;
    const cal = get("calendar").toUpperCase();
    if (cal) {
      if (cal === "AD" || cal === "BS") calendar = cal;
      else if (["ई.सं.", "ई.सं", "AD."].includes(cal)) calendar = "AD";
      else if (["वि.सं.", "वि.सं", "BS."].includes(cal)) calendar = "BS";
      else errors.push("bad_calendar");
    }

    let category = defaults.category;
    if (get("category")) {
      const c = categoryFrom(get("category"));
      if (c) category = c;
      else errors.push("bad_category");
    }

    let repeatYearly = defaults.repeatYearly;
    if (get("repeat")) {
      const r = yesNo(get("repeat"));
      if (r === null) errors.push("bad_repeat");
      else repeatYearly = r;
    }

    const date = normalizeDate(get("date"));
    if (!date) errors.push("missing_date");
    else if (!validDate(date, calendar, repeatYearly)) errors.push("bad_date");

    let localTime = defaults.localTime;
    const tm = latinDigits(get("time"));
    if (tm) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(tm);
      if (m && Number(m[1]) < 24 && Number(m[2]) < 60) localTime = `${m[1].padStart(2, "0")}:${m[2]}`;
      else errors.push("bad_time");
    }

    let offsetsDays = defaults.offsetsDays;
    const rem = latinDigits(get("remind"));
    if (rem) {
      const parts = rem.split(/[;|\s,/]+/).filter(Boolean).map(Number);
      if (parts.length === 0 || parts.length > MAX_REMINDERS_PER_CYCLE || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 1825)) errors.push("bad_remind");
      else offsetsDays = parts;
    }
    const offsets = [...new Set(offsetsDays)].map((d) => d * 1440);

    const key = `${label.toLowerCase()}|${date}`;
    const duplicate = seen.has(key);
    seen.set(key, idx);
    return {
      line: idx + (header ? 2 : 1),
      label, date, calendar, category, localTime, offsets, repeatYearly,
      notes: get("notes").slice(0, 500) || null,
      familyMemberLabel: get("for").slice(0, 60) || null,
      errors, duplicate,
    };
  });
  return { rows, headerDetected: Boolean(header), tooMany };
}

export const SAMPLE_CSV = `name,date,calendar,remind,notes
Ram Sharma,2052-04-15,BS,1;0,School friend
Sita Karki,1996-11-02,AD,7;1;0,
Hari Thapa,2055-10-28,BS,,Cousin
`;
