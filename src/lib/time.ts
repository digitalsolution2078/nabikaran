/**
 * Asia/Kathmandu is UTC+05:45 with no daylight saving, so conversions are a
 * fixed offset. All persisted timestamps are UTC; presentation is Nepal time.
 */
export const KATHMANDU_OFFSET_MINUTES = 5 * 60 + 45;
export const DEFAULT_LOCAL_TIME = "09:00";

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseLocalTime(value: string | undefined | null): { hour: number; minute: number } {
  const m = LOCAL_TIME_RE.exec(value ?? DEFAULT_LOCAL_TIME);
  if (!m) throw new Error("Invalid local time, expected HH:MM");
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Build the UTC instant for a Gregorian calendar date + wall-clock time in Kathmandu. */
export function kathmanduToUtc(date: LocalDate, localTime: string = DEFAULT_LOCAL_TIME): Date {
  const { hour, minute } = parseLocalTime(localTime);
  const asIfUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0, 0);
  return new Date(asIfUtc - KATHMANDU_OFFSET_MINUTES * 60_000);
}

/** Wall-clock components in Kathmandu for a UTC instant. */
export function utcToKathmandu(d: Date): LocalDate & { hour: number; minute: number } {
  const shifted = new Date(d.getTime() + KATHMANDU_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatKathmandu(d: Date, withTime = true): string {
  const k = utcToKathmandu(d);
  const date = `${k.year}-${pad2(k.month)}-${pad2(k.day)}`;
  return withTime ? `${date} ${pad2(k.hour)}:${pad2(k.minute)}` : date;
}

export function parseIsoDate(value: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Whole days between two instants, rounded to nearest day (for message copy). */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}
