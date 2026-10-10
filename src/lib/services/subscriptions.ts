import { getDb, type Db } from "../db";

/** Pro subscription manager: read model over renewal_items with subscription details. */
export interface SubscriptionItem {
  id: string;
  label: string;
  status: string;
  nextAt: string;
  amount: number | null;
  currency: string;
  cycleMonths: number | null;
  paymentMethod: string | null;
  autoRenew: boolean | null;
  channels: string[];
}

export interface SubscriptionsView {
  items: SubscriptionItem[];
  upcoming: SubscriptionItem[];
  /** Per currency: what the repeating subscriptions cost per month and per year. */
  totals: Array<{ currency: string; monthly: number; yearly: number }>;
}

export async function listSubscriptions(userId: string, db: Db = getDb(), now: Date = new Date()): Promise<SubscriptionsView> {
  const { rows } = await db.query<{
    id: string; label: string; status: string; expiry_at_utc: string; sub_amount: string | null; sub_currency: string | null; repeat_months: number | null; repeat_yearly: boolean;
    sub_payment_method: string | null; sub_auto_renew: boolean | null; channels: string[];
  }>(
    `select id, label, status, expiry_at_utc, sub_amount::text, sub_currency, repeat_months, repeat_yearly, sub_payment_method, sub_auto_renew, channels
       from renewal_items
      where owner_user_id = $1 and status <> 'deleted'
        and (sub_amount is not null or sub_payment_method is not null or repeat_months is not null or category = 'subscription')
      order by status = 'active' desc, expiry_at_utc`,
    [userId],
  );
  const items: SubscriptionItem[] = rows.map((r) => ({
    id: r.id,
    label: r.label,
    status: r.status,
    nextAt: new Date(r.expiry_at_utc).toISOString(),
    amount: r.sub_amount === null ? null : Number(r.sub_amount),
    currency: r.sub_currency ?? "NPR",
    cycleMonths: r.repeat_months ?? (r.repeat_yearly ? 12 : null),
    paymentMethod: r.sub_payment_method,
    autoRenew: r.sub_auto_renew,
    channels: r.channels ?? ["sms"],
  }));
  const totals = new Map<string, number>();
  for (const s of items) {
    if (s.status !== "active" || s.amount === null || !s.cycleMonths) continue;
    totals.set(s.currency, (totals.get(s.currency) ?? 0) + s.amount / s.cycleMonths);
  }
  const in30 = now.getTime() + 30 * 86_400_000;
  return {
    items,
    upcoming: items.filter((s) => s.status === "active" && new Date(s.nextAt).getTime() >= now.getTime() && new Date(s.nextAt).getTime() <= in30),
    totals: [...totals.entries()].map(([currency, monthly]) => ({ currency, monthly, yearly: monthly * 12 })).sort((a, b) => b.yearly - a.yearly),
  };
}
