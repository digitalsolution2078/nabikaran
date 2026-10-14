import { getDb, type Db } from "../db";
import { env } from "../env";
import { getSmsProvider, type SmsProvider } from "../providers/sms";
import { getEmailProvider } from "../providers/email";
import { utcToKathmandu } from "../time";
import { sendPushToUser } from "./push";
import { getSetting } from "./settings";

/**
 * Admin → Message usage: how many SMS credits are left on the provider account
 * (Aakash), how many SMS Nabikaran sent and for what, what customers were
 * charged for them and what they cost us. The balance is checked at most once
 * an hour by the reconciler (and on demand); below the alert level super admins
 * get one app notification + email a day.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface BalanceCheck {
  provider: string;
  available: number | null;
  totalSent: number | null;
  error: string | null;
  checkedAt: string;
}

const toCheck = (r: { provider: string; available: string | null; total_sent: string | null; error_text: string | null; checked_at: unknown }): BalanceCheck => ({
  provider: r.provider,
  available: r.available === null ? null : Number(r.available),
  totalSent: r.total_sent === null ? null : Number(r.total_sent),
  error: r.error_text,
  checkedAt: new Date(r.checked_at as string).toISOString(),
});

/** Ask the provider for its balance and store the answer (or the error). Null when the provider has no balance API. */
export async function checkSmsBalance(db: Db = getDb(), provider: SmsProvider = getSmsProvider(), now: Date = new Date()): Promise<BalanceCheck | null> {
  if (!provider.balance) return null;
  let available: number | null = null;
  let totalSent: number | null = null;
  let error: string | null = null;
  try {
    const b = await provider.balance();
    available = b.available;
    totalSent = b.totalSent ?? null;
  } catch (e) {
    error = (e as Error).message.slice(0, 300);
  }
  const { rows } = await db.query<{ provider: string; available: string | null; total_sent: string | null; error_text: string | null; checked_at: unknown }>(
    "insert into sms_balance_checks (provider, available, total_sent, error_text, checked_at) values ($1,$2,$3,$4,$5) returning provider, available::text, total_sent::text, error_text, checked_at",
    [provider.name, available, totalSent, error, now.toISOString()],
  );
  return toCheck(rows[0]);
}

/** The latest balance checks, newest first (the first one with a balance is the current balance). */
export async function balanceHistory(db: Db = getDb(), limit = 30): Promise<BalanceCheck[]> {
  const { rows } = await db.query<{ provider: string; available: string | null; total_sent: string | null; error_text: string | null; checked_at: unknown }>(
    "select provider, available::text, total_sent::text, error_text, checked_at from sms_balance_checks order by checked_at desc, id desc limit $1",
    [limit],
  );
  return rows.map(toCheck);
}

/** Reconciler step: hourly balance check and the once-a-day low-balance alert. Returns the number of staff alerted. */
export async function runSmsBalanceWatch(db: Db = getDb(), now: Date = new Date(), provider: SmsProvider = getSmsProvider()): Promise<number> {
  if (!provider.balance) return 0;
  const { rows: last } = await db.query<{ checked_at: unknown }>("select checked_at from sms_balance_checks order by checked_at desc limit 1");
  if (last[0] && now.getTime() - new Date(last[0].checked_at as string).getTime() < HOUR) return 0;
  const check = await checkSmsBalance(db, provider, now);
  if (!check || check.available === null) return 0;
  const s = await getSetting("usage", db);
  if (!s.alert || check.available >= s.low_balance) return 0;

  const day = utcToKathmandu(now);
  const stamp = `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
  const { rows: admins } = await db.query<{ id: string; email: string | null; verified: boolean }>(
    "select id, email, (email_verified_at is not null) as verified from users where role = 'super_admin' and status = 'active'",
  );
  const email = await getEmailProvider(db);
  const title = "SMS balance is low";
  const body = `${provider.name === "aakash" ? "Aakash" : provider.name} has ${Math.floor(check.available).toLocaleString("en-IN")} SMS credits left (alert below ${s.low_balance.toLocaleString("en-IN")}). Recharge so reminders and sign-in codes keep going.`;
  let alerted = 0;
  for (const a of admins) {
    const key = `sms-balance-low:${stamp}:${a.id}`;
    const { rows: ins } = await db.query("insert into user_notices (key, user_id, created_at) values ($1, $2, $3) on conflict (key) do nothing returning key", [key, a.id, now.toISOString()]);
    if (!ins[0]) continue;
    alerted++;
    await sendPushToUser(a.id, { title, body, url: "/admin/usage", tag: "sms-balance" }, db).catch(() => 0);
    if (email && a.email && a.verified) {
      const text = `${body}\n\nMessage usage: ${env.appUrl.replace(/\/$/, "")}/admin/usage`;
      await email.send({ to: a.email, subject: `Nabikaran: ${title}`, text, idempotencyKey: key }).catch(() => undefined);
    }
  }
  if (alerted) {
    await db.query("insert into audit_events (actor_via, action, target_type, target_id, json_detail_redacted) values ('worker','sms.balance_low','sms_account',$1,$2)", [
      provider.name, JSON.stringify({ available: check.available, threshold: s.low_balance }),
    ]);
  }
  return alerted;
}

export const CHANNELS = ["sms", "whatsapp", "email", "push"] as const;
export type Channel = (typeof CHANNELS)[number];
export const KINDS = ["reminder", "sign_in", "nudge", "low_credit", "digest", "welcome", "test", "other"] as const;
export type Kind = (typeof KINDS)[number];

export interface ChannelUsage {
  channel: Channel;
  sent: number;
  failed: number;
  /** Billable units: SMS parts for SMS, messages for WhatsApp, email and push. */
  units: number;
  /** Credits customers were charged (net of refunds). 1 credit = NPR 1. */
  chargedCredits: number;
  /** units × what the admin entered as our cost per unit (0 when not set; push is free). */
  costNpr: number;
}

export interface UsageReport {
  days: number;
  from: string;
  balance: BalanceCheck | null;
  lastCheck: BalanceCheck | null;
  history: BalanceCheck[];
  channels: ChannelUsage[];
  byKind: Array<{ channel: Channel; kind: Kind; sent: number; failed: number; units: number }>;
  daily: Array<{ day: string; sms: number; whatsapp: number; email: number; push: number }>;
  totals: { sent: number; chargedCredits: number; costNpr: number };
  avgDailySmsUnits7d: number;
  /** SMS balance ÷ average daily SMS use over the last 7 days. */
  daysLeft: number | null;
  settings: { alert: boolean; lowBalance: number; smsCost: number; whatsappCost: number; emailCost: number };
}

const nptDay = (d: Date) => {
  const k = utcToKathmandu(d);
  return `${k.year}-${String(k.month).padStart(2, "0")}-${String(k.day).padStart(2, "0")}`;
};

/** Usage of every channel for the last `days` days. */
export async function usageReport(days = 30, db: Db = getDb(), now: Date = new Date()): Promise<UsageReport> {
  const span = Math.min(366, Math.max(1, Math.floor(days)));
  const from = new Date(now.getTime() - span * DAY);
  const range = [from.toISOString(), now.toISOString()];
  const [settings, history, reminders, other, push, daily, charged, week] = await Promise.all([
    getSetting("usage", db),
    balanceHistory(db, 30),
    // Reminder messages on every paid channel.
    db.query<{ channel: string; sent: number; failed: number; units: string }>(
      `select coalesce(channel, 'sms') as channel, count(*) filter (where api_state = 'accepted')::int as sent, count(*) filter (where api_state = 'rejected')::int as failed,
              coalesce(sum(case when coalesce(channel, 'sms') = 'sms' then coalesce(reported_units, 1) else 1 end) filter (where api_state = 'accepted'), 0)::text as units
         from sms_attempts where request_at >= $1 and request_at <= $2 group by 1`,
      range,
    ),
    db.query<{ channel: string; kind: string; sent: number; failed: number; units: string }>(
      `select channel, kind, count(*) filter (where outcome <> 'rejected')::int as sent, count(*) filter (where outcome = 'rejected')::int as failed,
              coalesce(sum(case when channel = 'sms' then coalesce(units, segments) else 1 end) filter (where outcome <> 'rejected'), 0)::text as units
         from message_usage where created_at >= $1 and created_at <= $2 group by 1, 2`,
      range,
    ),
    db.query<{ sent: string }>("select coalesce(sum(sent), 0)::text as sent from push_deliveries where created_at >= $1 and created_at <= $2", range),
    db.query<{ day: string; channel: string; units: string }>(
      `with d as (
         select request_at as at, coalesce(channel, 'sms') as channel, case when coalesce(channel, 'sms') = 'sms' then coalesce(reported_units, 1) else 1 end::numeric as u
           from sms_attempts where api_state = 'accepted' and request_at >= $1 and request_at <= $2
         union all
         select created_at, channel, case when channel = 'sms' then coalesce(units, segments) else 1 end::numeric from message_usage where outcome <> 'rejected' and created_at >= $1 and created_at <= $2
         union all
         select created_at, 'push', sent::numeric from push_deliveries where sent > 0 and created_at >= $1 and created_at <= $2)
       select to_char(at at time zone 'Asia/Kathmandu', 'YYYY-MM-DD') as day, channel, sum(u)::text as units from d group by 1, 2`,
      range,
    ),
    db.query<{ channel: string; credits: string }>(
      `select coalesce(j.channel, 'sms') as channel, coalesce(-sum(l.signed_credits), 0)::text as credits
         from wallet_ledger l join reminder_jobs j on l.reference_type = 'reminder_job' and j.id::text = l.reference_id
        where l.type in ('debit','reversal') and l.created_at >= $1 and l.created_at <= $2 group by 1`,
      range,
    ),
    db.query<{ units: string }>(
      `select (coalesce((select sum(coalesce(reported_units, 1)) from sms_attempts where coalesce(channel, 'sms') = 'sms' and api_state = 'accepted' and request_at >= $1 and request_at <= $2), 0)
             + coalesce((select sum(coalesce(units, segments)) from message_usage where channel = 'sms' and outcome <> 'rejected' and created_at >= $1 and created_at <= $2), 0))::text as units`,
      [new Date(now.getTime() - 7 * DAY).toISOString(), now.toISOString()],
    ),
  ]);

  const cost: Record<Channel, number> = { sms: settings.sms_cost, whatsapp: settings.whatsapp_cost, email: settings.email_cost, push: 0 };
  const key = (c: string, k: string) => `${c}:${k}`;
  const kinds = new Map<string, UsageReport["byKind"][number]>();
  const add = (channel: string, kind: string, sent: number, failed: number, units: number) => {
    const c = ((CHANNELS as readonly string[]).includes(channel) ? channel : "sms") as Channel;
    const k = ((KINDS as readonly string[]).includes(kind) ? kind : "other") as Kind;
    const row = kinds.get(key(c, k)) ?? { channel: c, kind: k, sent: 0, failed: 0, units: 0 };
    row.sent += sent;
    row.failed += failed;
    row.units += units;
    kinds.set(key(c, k), row);
  };
  for (const r of reminders.rows) add(r.channel, "reminder", r.sent, r.failed, Number(r.units));
  for (const r of other.rows) add(r.channel, r.kind, r.sent, r.failed, Number(r.units));
  const pushSent = Number(push.rows[0]?.sent ?? 0);
  if (pushSent) add("push", "other", pushSent, 0, pushSent);

  const chargedBy = new Map(charged.rows.map((r) => [r.channel, Number(r.credits)]));
  const byKind = [...kinds.values()].sort((a, b) => CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  const channels: ChannelUsage[] = CHANNELS.map((channel) => {
    const rows = byKind.filter((k) => k.channel === channel);
    const units = rows.reduce((n, r) => n + r.units, 0);
    return {
      channel,
      sent: rows.reduce((n, r) => n + r.sent, 0),
      failed: rows.reduce((n, r) => n + r.failed, 0),
      units: Math.round(units * 100) / 100,
      chargedCredits: Math.round((chargedBy.get(channel) ?? 0) * 100) / 100,
      costNpr: Math.round(units * cost[channel] * 100) / 100,
    };
  });

  // One row per Nepal day, including quiet days.
  const per = new Map<string, UsageReport["daily"][number]>();
  for (let t = from.getTime() + DAY; t <= now.getTime() + 1; t += DAY) {
    const day = nptDay(new Date(t));
    if (!per.has(day)) per.set(day, { day, sms: 0, whatsapp: 0, email: 0, push: 0 });
  }
  for (const r of daily.rows) {
    const row = per.get(r.day);
    if (row && (CHANNELS as readonly string[]).includes(r.channel)) row[r.channel as Channel] += Number(r.units);
  }

  const balance = history.find((h) => h.available !== null) ?? null;
  const avg = Number(week.rows[0]?.units ?? 0) / 7;
  return {
    days: span,
    from: from.toISOString(),
    balance,
    lastCheck: history[0] ?? null,
    history,
    channels,
    byKind,
    daily: [...per.values()],
    totals: {
      sent: channels.reduce((n, c) => n + c.sent, 0),
      chargedCredits: Math.round(channels.reduce((n, c) => n + c.chargedCredits, 0) * 100) / 100,
      costNpr: Math.round(channels.reduce((n, c) => n + c.costNpr, 0) * 100) / 100,
    },
    avgDailySmsUnits7d: Math.round(avg * 10) / 10,
    daysLeft: balance?.available != null && avg > 0 ? Math.floor(balance.available / avg) : null,
    settings: { alert: settings.alert, lowBalance: settings.low_balance, smsCost: settings.sms_cost, whatsappCost: settings.whatsapp_cost, emailCost: settings.email_cost },
  };
}
