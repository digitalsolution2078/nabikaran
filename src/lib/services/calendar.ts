import { randomBytes } from "node:crypto";
import { getDb, type Db } from "../db";
import { env } from "../env";
import { audit } from "../core/audit";
import { isPro, requirePro } from "./plans";
import { utcToKathmandu, pad2 } from "../time";

/**
 * Pro calendar feed: a secret, read-only iCalendar (.ics) link per account that
 * Google Calendar, Apple Calendar and Outlook subscribe to. No Google sign-in or
 * write access: the calendar app fetches the feed itself (Google every few hours).
 * Resetting the link stops the old one at once. When Pro ends the feed is empty.
 */
const appUrl = () => env.appUrl.replace(/\/$/, "");
const who = (userId: string) => ({ userId, via: "web" as const, scopes: [], locale: "en" });

export interface CalendarLink {
  enabled: boolean;
  /** https://…/api/calendar/<token>.ics */
  url: string | null;
  /** webcal://… (Apple Calendar, and Google's "add by URL") */
  webcal: string | null;
  google: string | null;
  outlook: string | null;
  createdAt: string | null;
}

export function calendarLinks(token: string | null, createdAt: string | null = null): CalendarLink {
  if (!token) return { enabled: false, url: null, webcal: null, google: null, outlook: null, createdAt: null };
  const url = `${appUrl()}/api/calendar/${token}.ics`;
  const webcal = url.replace(/^https?:\/\//, "webcal://");
  return {
    enabled: true,
    url,
    webcal,
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(url)}&name=${encodeURIComponent("Nabikaran")}`,
    createdAt,
  };
}

export async function getCalendarLink(userId: string, db: Db = getDb()): Promise<CalendarLink> {
  const { rows } = await db.query<{ calendar_token: string | null; calendar_token_at: string | null }>(
    "select calendar_token, calendar_token_at from users where id = $1",
    [userId],
  );
  return calendarLinks(rows[0]?.calendar_token ?? null, rows[0]?.calendar_token_at ? new Date(rows[0].calendar_token_at).toISOString() : null);
}

/** Turn the feed on (keeps an existing link) or, with reset, replace the link. Pro only. */
export async function enableCalendar(userId: string, opts: { reset?: boolean } = {}, db: Db = getDb()): Promise<CalendarLink> {
  await requirePro(userId, db);
  const current = await getCalendarLink(userId, db);
  if (current.enabled && !opts.reset) return current;
  const token = randomBytes(24).toString("base64url");
  await db.query("update users set calendar_token = $2, calendar_token_at = now() where id = $1", [userId, token]);
  await audit(db, who(userId), opts.reset ? "calendar.reset" : "calendar.enabled", { type: "user", id: userId }, {});
  return getCalendarLink(userId, db);
}

export async function disableCalendar(userId: string, db: Db = getDb()): Promise<CalendarLink> {
  await db.query("update users set calendar_token = null, calendar_token_at = null where id = $1", [userId]);
  await audit(db, who(userId), "calendar.disabled", { type: "user", id: userId }, {});
  return calendarLinks(null);
}

// ---- iCalendar ---------------------------------------------------------------

/** RFC 5545 text escaping. */
export function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold lines longer than 75 octets (continuation lines start with a space). */
export function icsFold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    if (len + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      len = 0;
    }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const ymd = (y: number, m: number, d: number) => `${y}${pad2(m)}${pad2(d)}`;

function nextDay(y: number, m: number, d: number): string {
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

interface FeedRow {
  id: string;
  category: string;
  label: string;
  expiry_at_utc: string;
  date_input_calendar: string;
  repeat_yearly: boolean | null;
  repeat_months: number | null;
  sub_amount: string | null;
  sub_currency: string | null;
  sub_payment_method: string | null;
  sub_is_trial: boolean | null;
  family_member_label: string | null;
  cycle_no: number;
  updated_at: string;
}

function title(r: FeedRow): string {
  const money = r.sub_amount !== null ? ` · ${r.sub_currency ?? "NPR"} ${Number(r.sub_amount).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "";
  const who = r.family_member_label ? ` (${r.family_member_label})` : "";
  if (r.category === "cancel_deadline") return `Last day to cancel: ${r.label}`;
  if (r.category === "free_trial" || r.sub_is_trial) return `Free trial ends: ${r.label}${money}`;
  if (r.category === "subscription" || r.sub_amount !== null) return `${r.label}${money}${who}`;
  return `${r.label}${who}`;
}

/** Build the feed for a set of reminders. Pure: no database access. */
export function buildIcs(rows: FeedRow[], now: Date = new Date(), name = "Nabikaran"): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nabikaran//Renewal reminders//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(name)}`,
    "X-WR-TIMEZONE:Asia/Kathmandu",
    "X-PUBLISHED-TTL:PT6H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
  ];
  for (const r of rows) {
    const k = utcToKathmandu(new Date(r.expiry_at_utc));
    // A repeat rule only when the calendar app would get the dates right: AD dates
    // that exist in every month (BS dates and the 29th–31st move from cycle to cycle).
    // Otherwise the next date shows up after the reminder rolls over.
    let rrule: string | null = null;
    if (r.date_input_calendar === "AD") {
      if (r.repeat_yearly && !(k.month === 2 && k.day === 29)) rrule = "RRULE:FREQ=YEARLY";
      else if (r.repeat_months && k.day <= 28) rrule = `RRULE:FREQ=MONTHLY;INTERVAL=${r.repeat_months}`;
    }
    const desc = [
      r.sub_payment_method ? `Payment: ${r.sub_payment_method}` : null,
      `Open in Nabikaran: ${appUrl()}/renewals/${r.id}`,
    ].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${r.id}@nabikaran.org`,
      `DTSTAMP:${stamp(now)}`,
      `LAST-MODIFIED:${stamp(new Date(r.updated_at))}`,
      `SEQUENCE:${r.cycle_no}`,
      `DTSTART;VALUE=DATE:${ymd(k.year, k.month, k.day)}`,
      `DTEND;VALUE=DATE:${nextDay(k.year, k.month, k.day)}`,
      ...(rrule ? [rrule] : []),
      `SUMMARY:${icsEscape(title(r))}`,
      `DESCRIPTION:${icsEscape(desc)}`,
      `URL:${appUrl()}/renewals/${r.id}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

/**
 * The feed for a link. Null for an unknown (or reset) link. A known link on an
 * account without Pro gets an empty calendar, so old events disappear from the
 * calendar app instead of staying stale.
 */
export async function feedForToken(token: string, db: Db = getDb(), now: Date = new Date()): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const { rows: u } = await db.query<{ id: string }>("select id from users where calendar_token = $1 and status = 'active'", [token]);
  if (!u[0]) return null;
  if (!(await isPro(u[0].id, db, now))) return buildIcs([], now);
  const { rows } = await db.query<FeedRow>(
    `select id, category, label, expiry_at_utc, date_input_calendar, repeat_yearly, repeat_months, sub_amount::text, sub_currency,
            sub_payment_method, sub_is_trial, family_member_label, cycle_no, updated_at
       from renewal_items
      where owner_user_id = $1 and status = 'active' and expiry_at_utc >= $2::timestamptz - interval '30 days'
      order by expiry_at_utc limit 2000`,
    [u[0].id, now.toISOString()],
  );
  return buildIcs(rows, now);
}

/** "Add to Google Calendar" for one date (a prefilled event the user saves). */
export function googleTemplateLink(input: { label: string; expiryUtc: string; details?: string }): string {
  const k = utcToKathmandu(new Date(input.expiryUtc));
  const dates = `${ymd(k.year, k.month, k.day)}/${nextDay(k.year, k.month, k.day)}`;
  const q = new URLSearchParams({ action: "TEMPLATE", text: input.label, dates, details: input.details ?? "", ctz: "Asia/Kathmandu" });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}
