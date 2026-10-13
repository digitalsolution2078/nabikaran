import { getDb, type Db } from "../db";
import { roundCredits } from "../core/wallet";

/**
 * Revenue dashboard (Admin → Revenue). Money in = rupees actually received:
 * approved QR / Fonepay / counter top-ups and gift-card sales, plus paid
 * gateway orders (Khalti, eSewa) minus refunded ones. Credits (1 credit =
 * NPR 1) show how that prepaid value was used: messages sent, promotions
 * given, and what customers still hold. All days are Nepal days.
 */
export interface RevenueRange { from: string; to: string } // YYYY-MM-DD, inclusive, Nepal time

export interface RevenueReport {
  range: RevenueRange;
  moneyIn: { totalNpr: number; walletNpr: number; giftNpr: number; refundsNpr: number; payments: number };
  byMethod: Array<{ method: string; npr: number; count: number }>;
  daily: Array<{ day: string; npr: number }>;
  usage: Array<{ channel: "sms" | "whatsapp" | "email"; messages: number; credits: number }>;
  promotions: { topupBonus: number; referral: number; coupons: number; proCreditsNet: number; adjustments: number; total: number };
  signInFees: number;
  pro: { sold: number; credits: number; trials: number; activePaying: number };
  liability: { creditsHeld: number; reserved: number; customersWithCredit: number };
  customers: { newSignups: number; paying: number };
}

const TZ = "Asia/Kathmandu";
const isoDay = (d: Date) => new Date(d.getTime() + 345 * 60_000).toISOString().slice(0, 10);

export function presetRange(preset: string, now = new Date()): RevenueRange {
  const today = isoDay(now);
  const shift = (days: number) => isoDay(new Date(now.getTime() - days * 86_400_000));
  const [y, m] = today.split("-").map(Number);
  const firstOfMonth = `${today.slice(0, 8)}01`;
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: shift(6), to: today };
    case "month":
      return { from: firstOfMonth, to: today };
    case "lastmonth": {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      const last = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
      return { from: `${ly}-${String(lm).padStart(2, "0")}-01`, to: `${ly}-${String(lm).padStart(2, "0")}-${String(last).padStart(2, "0")}` };
    }
    case "90d":
      return { from: shift(89), to: today };
    default:
      return { from: shift(29), to: today };
  }
}

export function validRange(from?: string | null, to?: string | null): RevenueRange | null {
  const ok = (s?: string | null) => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)));
  if (!ok(from) || !ok(to) || from! > to!) return null;
  const days = (Date.parse(to!) - Date.parse(from!)) / 86_400_000;
  return days <= 366 ? { from: from!, to: to! } : null;
}

const methodLabel = (source: string, qrMode: string | null, method: string | null, purpose: string) => {
  const base = source === "counter" ? `Counter · ${method ?? "cash"}` : qrMode === "dynamic" ? "Fonepay QR (automatic)" : "QR (verified by staff)";
  return purpose === "gift" ? `${base} · gift card` : base;
};

export async function revenueReport(range: RevenueRange, db: Db = getDb()): Promise<RevenueReport> {
  // [start, end) in UTC for the Nepal-day range.
  const bounds = [range.from, range.to];
  const between = (col: string) => `${col} >= ($1::date::timestamp at time zone '${TZ}') and ${col} < (($2::date + 1)::timestamp at time zone '${TZ}')`;

  const [manual, orders, refunds, daily, usage, ledger, pro, liability, customers] = await Promise.all([
    db.query<{ source: string; qr_mode: string | null; payment_method: string | null; purpose: string; npr: string; n: number }>(
      `select source, qr_mode, payment_method, purpose, (sum(amount_paisa) / 100.0)::text as npr, count(*)::int as n
         from manual_topup_requests where status = 'approved' and ${between("decided_at")}
        group by 1, 2, 3, 4`,
      bounds,
    ),
    db.query<{ gateway: string; npr: string; n: number }>(
      `select gateway, (sum(amount_paisa) / 100.0)::text as npr, count(*)::int as n
         from payment_orders where status in ('paid','refunded') and paid_at is not null and ${between("paid_at")} group by 1`,
      bounds,
    ),
    db.query<{ npr: string }>(
      `select coalesce(sum(amount_paisa) / 100.0, 0)::text as npr from payment_orders where status = 'refunded' and ${between("updated_at")}`,
      bounds,
    ),
    db.query<{ day: string; npr: string }>(
      `with m as (
         select (decided_at at time zone '${TZ}')::date as day, amount_paisa from manual_topup_requests where status = 'approved' and ${between("decided_at")}
         union all
         select (paid_at at time zone '${TZ}')::date, amount_paisa from payment_orders where status in ('paid','refunded') and paid_at is not null and ${between("paid_at")}
       )
       select d::date::text as day, coalesce((select sum(amount_paisa) from m where m.day = d::date), 0) / 100.0 as npr
         from generate_series($1::date, $2::date, interval '1 day') d order by 1`,
      bounds,
    ),
    db.query<{ channel: string; messages: number; credits: string }>(
      `select coalesce(j.channel, 'sms') as channel, count(*) filter (where l.type = 'debit')::int as messages, (-sum(l.signed_credits))::text as credits
         from wallet_ledger l join reminder_jobs j on j.id::text = l.reference_id
        where l.reference_type = 'reminder_job' and l.type in ('debit','reversal') and ${between("l.created_at")}
        group by 1`,
      bounds,
    ),
    db.query<{ type: string; reference_type: string | null; credits: string }>(
      `select type, reference_type, sum(signed_credits)::text as credits from wallet_ledger
        where type in ('bonus','referral','coupon','gift','pro_credit','pro_expiry','adjustment','fee') and ${between("created_at")} group by 1, 2`,
      bounds,
    ),
    db.query<{ sold: number; credits: string; trials: number; active: number }>(
      `select count(*) filter (where kind = 'paid' and ${between("created_at")})::int as sold,
              coalesce(sum(price_credits) filter (where kind = 'paid' and ${between("created_at")}), 0)::text as credits,
              count(*) filter (where kind = 'trial' and ${between("created_at")})::int as trials,
              count(distinct user_id) filter (where kind = 'paid' and status = 'active' and starts_at <= now() and ends_at > now())::int as active
         from user_plans`,
      bounds,
    ),
    db.query<{ held: string; reserved: string; n: number }>(
      `select coalesce(sum(greatest(w.posted_balance_credits, 0)), 0)::text as held, coalesce(sum(w.reserved_credits), 0)::text as reserved,
              count(*) filter (where w.posted_balance_credits > 0)::int as n
         from wallets w join users u on u.id = w.user_id where u.role = 'user'`,
    ),
    db.query<{ signups: number; paying: number }>(
      `select (select count(*) from users where role = 'user' and ${between("created_at")})::int as signups,
              (select count(distinct user_id) from (
                 select user_id from manual_topup_requests where status = 'approved' and purpose = 'wallet' and ${between("decided_at")}
                 union select user_id from payment_orders where status = 'paid' and ${between("paid_at")}) p)::int as paying`,
      bounds,
    ),
  ]);

  const byMethod = new Map<string, { method: string; npr: number; count: number }>();
  let walletNpr = 0;
  let giftNpr = 0;
  let payments = 0;
  for (const r of manual.rows) {
    const label = methodLabel(r.source, r.qr_mode, r.payment_method, r.purpose);
    const cur = byMethod.get(label) ?? { method: label, npr: 0, count: 0 };
    cur.npr += Number(r.npr);
    cur.count += r.n;
    byMethod.set(label, cur);
    if (r.purpose === "gift") giftNpr += Number(r.npr);
    else walletNpr += Number(r.npr);
    payments += r.n;
  }
  for (const r of orders.rows) {
    const label = r.gateway === "esewa" ? "eSewa" : r.gateway === "khalti" ? "Khalti" : r.gateway === "fonepay" ? "Fonepay checkout" : r.gateway;
    const cur = byMethod.get(label) ?? { method: label, npr: 0, count: 0 };
    cur.npr += Number(r.npr);
    cur.count += r.n;
    byMethod.set(label, cur);
    walletNpr += Number(r.npr);
    payments += r.n;
  }
  const refundsNpr = Number(refunds.rows[0]?.npr ?? 0);

  const sumType = (types: string[], filter?: (ref: string | null) => boolean) =>
    roundCredits(ledger.rows.filter((r) => types.includes(r.type) && (!filter || filter(r.reference_type))).reduce((n, r) => n + Number(r.credits), 0));
  const promotions = {
    topupBonus: sumType(["bonus"]),
    referral: sumType(["referral"]),
    // Admin coupons are promotions; gift cards were paid for (counted in money in).
    coupons: sumType(["coupon"]),
    proCreditsNet: sumType(["pro_credit", "pro_expiry"]),
    adjustments: sumType(["adjustment"]),
    total: 0,
  };
  promotions.total = roundCredits(promotions.topupBonus + promotions.referral + promotions.coupons + promotions.proCreditsNet + promotions.adjustments);

  return {
    range,
    moneyIn: { totalNpr: roundCredits(walletNpr + giftNpr - refundsNpr), walletNpr: roundCredits(walletNpr), giftNpr: roundCredits(giftNpr), refundsNpr, payments },
    byMethod: [...byMethod.values()].map((m) => ({ ...m, npr: roundCredits(m.npr) })).sort((a, b) => b.npr - a.npr),
    daily: daily.rows.map((r) => ({ day: r.day, npr: roundCredits(Number(r.npr)) })),
    usage: (["sms", "whatsapp", "email"] as const).map((ch) => {
      const r = usage.rows.find((x) => x.channel === ch);
      return { channel: ch, messages: r?.messages ?? 0, credits: roundCredits(Number(r?.credits ?? 0)) };
    }),
    promotions,
    signInFees: roundCredits(-sumType(["fee"])),
    pro: { sold: pro.rows[0].sold, credits: roundCredits(Number(pro.rows[0].credits)), trials: pro.rows[0].trials, activePaying: pro.rows[0].active },
    liability: { creditsHeld: roundCredits(Number(liability.rows[0].held)), reserved: roundCredits(Number(liability.rows[0].reserved)), customersWithCredit: liability.rows[0].n },
    customers: { newSignups: customers.rows[0].signups, paying: customers.rows[0].paying },
  };
}

/** Daily money-in rows for CSV export. */
export function revenueCsv(r: RevenueReport): string {
  const lines = ["date,money_in_npr", ...r.daily.map((d) => `${d.day},${d.npr.toFixed(2)}`)];
  lines.push("", "method,npr,payments", ...r.byMethod.map((m) => `"${m.method.replace(/"/g, '""')}",${m.npr.toFixed(2)},${m.count}`));
  lines.push("", "channel,messages,credits", ...r.usage.map((u) => `${u.channel},${u.messages},${u.credits.toFixed(2)}`));
  return lines.join("\n") + "\n";
}
