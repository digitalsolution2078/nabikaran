import { getDb, type Db } from "../db";
import { listSubscriptions, type SubscriptionItem } from "./subscriptions";

/**
 * Pro dashboard and Insights: deadlines, commitments and what is coming up.
 * Only figures the customer entered are shown; nothing is estimated from usage.
 */
export interface DeadlineItem {
  id: string;
  label: string;
  category: string;
  dueAt: string;
  amount: number | null;
  currency: string | null;
  linkedTo: string | null;
}

export interface Insights {
  totals: Array<{ currency: string; monthly: number; yearly: number }>;
  byMethod: Array<{ method: string; currency: string; monthly: number; count: number }>;
  upcoming30: SubscriptionItem[];
  upcoming90Total: Array<{ currency: string; amount: number }>;
  deadlines30: DeadlineItem[];
  cancelAlerts: DeadlineItem[];
  trialsEnding: DeadlineItem[];
  spentLast12: Array<{ currency: string; amount: number; renewals: number }>;
  subscriptionCount: number;
}

export async function getInsights(userId: string, db: Db = getDb(), now: Date = new Date()): Promise<Insights> {
  const subs = await listSubscriptions(userId, db, now);
  const active = subs.items.filter((s) => s.status === "active");
  const methods = new Map<string, { method: string; currency: string; monthly: number; count: number }>();
  for (const s of active) {
    if (s.amount === null || !s.cycleMonths) continue;
    const method = s.paymentMethod?.trim() || "—";
    const k = `${method}|${s.currency}`;
    const m = methods.get(k) ?? { method, currency: s.currency, monthly: 0, count: 0 };
    m.monthly += s.amount / s.cycleMonths;
    m.count++;
    methods.set(k, m);
  }
  const in90 = now.getTime() + 90 * 86_400_000;
  const up90 = new Map<string, number>();
  for (const s of active) {
    if (s.amount === null) continue;
    const t = new Date(s.nextAt).getTime();
    if (t >= now.getTime() && t <= in90) up90.set(s.currency, (up90.get(s.currency) ?? 0) + s.amount);
  }
  const { rows } = await db.query<{ id: string; label: string; category: string; expiry_at_utc: string; sub_amount: string | null; sub_currency: string | null; linked_to: string | null }>(
    `select id, label, category, expiry_at_utc, sub_amount::text, sub_currency, linked_to from renewal_items
      where owner_user_id = $1 and status = 'active' and expiry_at_utc >= $2 and expiry_at_utc <= $3 order by expiry_at_utc`,
    [userId, now.toISOString(), new Date(now.getTime() + 30 * 86_400_000).toISOString()],
  );
  const items: DeadlineItem[] = rows.map((r) => ({
    id: r.id, label: r.label, category: r.category, dueAt: new Date(r.expiry_at_utc).toISOString(),
    amount: r.sub_amount === null ? null : Number(r.sub_amount), currency: r.sub_currency, linkedTo: r.linked_to,
  }));
  const { rows: spent } = await db.query<{ currency: string; amount: string; n: number }>(
    `select currency, sum(amount)::text as amount, count(*)::int as n from renewal_history
      where user_id = $1 and amount is not null and renewed_on >= ($2::date - interval '12 months') group by currency order by sum(amount) desc`,
    [userId, now.toISOString().slice(0, 10)],
  );
  return {
    totals: subs.totals,
    byMethod: [...methods.values()].sort((a, b) => b.monthly - a.monthly),
    upcoming30: subs.upcoming,
    upcoming90Total: [...up90.entries()].map(([currency, amount]) => ({ currency, amount })),
    deadlines30: items.filter((i) => i.category !== "cancel_deadline"),
    cancelAlerts: items.filter((i) => i.category === "cancel_deadline"),
    trialsEnding: items.filter((i) => i.category === "free_trial"),
    spentLast12: spent.map((r) => ({ currency: r.currency ?? "NPR", amount: Number(r.amount), renewals: r.n })),
    subscriptionCount: active.length,
  };
}
