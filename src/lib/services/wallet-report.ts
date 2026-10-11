import { getDb, type Db } from "../db";
import { readWallet, type WalletView } from "../core/wallet";

/**
 * Finance-grade view of the append-only ledger. Every row is classified:
 *   purchased       top-up credited (Khalti or QR)
 *   spent_sms       SMS charged on provider acceptance
 *   spent_whatsapp  WhatsApp template message charged on acceptance
 *   refunded        charge reversed because the provider reported failure
 *   reversed        a top-up reversed (refund / chargeback)
 *   fee             sign-in SMS
 *   adjustment      admin credit/debit with a recorded reason
 *   bonus           referral bonus credits
 *   spent_email     email reminder charged beyond the Pro allowance
 *   plan            Nabikaran Pro bought with wallet credits
 *   coupon          coupon code or gift card redeemed
 * Reservations are not ledger rows: they are holds shown separately.
 */
export type LedgerCategory = "purchased" | "spent_sms" | "spent_whatsapp" | "spent_email" | "refunded" | "reversed" | "fee" | "adjustment" | "bonus" | "plan" | "coupon";

export interface StatementRow {
  id: number;
  createdAt: string;
  category: LedgerCategory;
  credits: number;
  channel: "sms" | "whatsapp" | "email" | null;
  description: string;
  reference: string | null;
}

export interface Statement {
  wallet: WalletView;
  totals: Record<LedgerCategory, number>;
  rows: StatementRow[];
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export function categorize(type: string, referenceType: string | null, channel: string | null): LedgerCategory {
  if (type === "topup") return "purchased";
  if (type === "fee") return "fee";
  if (type === "referral") return "bonus";
  if (type === "plan") return "plan";
  if (type === "coupon" || type === "gift") return "coupon";
  if (type === "adjustment") return "adjustment";
  if (type === "debit") return channel === "whatsapp" ? "spent_whatsapp" : channel === "email" ? "spent_email" : "spent_sms";
  if (type === "reversal") return referenceType === "payment_order" ? "reversed" : "refunded";
  return "adjustment";
}

export async function getStatement(userId: string, db: Db = getDb(), limit = 300): Promise<Statement> {
  const [wallet, rows, totals] = await Promise.all([
    readWallet(userId, db),
    db.query<{ id: string; created_at: unknown; type: string; signed_credits: string; reference_type: string | null; reference_id: string | null; memo: string | null; channel: string | null; label: string | null }>(
      `select l.id, l.created_at, l.type, l.signed_credits::text, l.reference_type, l.reference_id, l.memo, j.channel, i.label
         from wallet_ledger l
         left join reminder_jobs j on l.reference_type = 'reminder_job' and j.id::text = l.reference_id
         left join renewal_items i on i.id = j.renewal_id
        where l.user_id = $1 order by l.created_at desc, l.id desc limit $2`,
      [userId, limit],
    ),
    db.query<{ type: string; reference_type: string | null; channel: string | null; total: string }>(
      `select l.type, l.reference_type, j.channel, sum(l.signed_credits)::text as total
         from wallet_ledger l left join reminder_jobs j on l.reference_type = 'reminder_job' and j.id::text = l.reference_id
        where l.user_id = $1 group by 1, 2, 3`,
      [userId],
    ),
  ]);
  const t: Record<LedgerCategory, number> = { purchased: 0, spent_sms: 0, spent_whatsapp: 0, spent_email: 0, refunded: 0, reversed: 0, fee: 0, adjustment: 0, bonus: 0, plan: 0, coupon: 0 };
  for (const r of totals.rows) t[categorize(r.type, r.reference_type, r.channel)] += Number(r.total);
  return {
    wallet,
    totals: t,
    rows: rows.rows.map((r) => {
      const category = categorize(r.type, r.reference_type, r.channel);
      return {
        id: Number(r.id),
        createdAt: iso(r.created_at),
        category,
        credits: Number(r.signed_credits),
        channel: r.channel === "whatsapp" ? "whatsapp" : r.channel === "sms" ? "sms" : null,
        description: r.label ?? r.memo ?? "",
        reference: r.reference_type === "reminder_job" ? null : r.reference_id,
      };
    }),
  };
}

export interface TopupRow {
  kind: "khalti" | "qr";
  id: string;
  method: string;
  amountNpr: number;
  credits: number;
  reference: string;
  status: string;
  createdAt: string;
  paidAt: string | null;
  receipt: boolean;
}

/** Both payment paths in one history: automated Khalti orders and QR (Fonepay) requests. */
export async function listTopups(userId: string, db: Db = getDb()): Promise<TopupRow[]> {
  const [orders, manual] = await Promise.all([
    db.query<{ id: string; gateway: string; order_reference: string; amount_paisa: string; credits: string; status: string; created_at: unknown; paid_at: unknown }>(
      "select id, gateway, order_reference, amount_paisa::text, credits::text, status, created_at, paid_at from payment_orders where user_id = $1 order by created_at desc limit 100",
      [userId],
    ),
    db.query<{ id: string; reference: string; amount_paisa: string; credits: string; status: string; created_at: unknown; decided_at: unknown; qr_mode: string }>(
      "select id, reference, amount_paisa::text, credits::text, status, created_at, decided_at, qr_mode from manual_topup_requests where user_id = $1 order by created_at desc limit 100",
      [userId],
    ),
  ]);
  const rows: TopupRow[] = [
    ...orders.rows.map((o) => ({
      kind: "khalti" as const, id: o.id, method: o.gateway === "khalti" ? "Khalti (automatic)" : `${o.gateway} (automatic)`,
      amountNpr: Number(o.amount_paisa) / 100, credits: Number(o.credits), reference: o.order_reference, status: o.status,
      createdAt: iso(o.created_at), paidAt: o.paid_at ? iso(o.paid_at) : null, receipt: o.status === "paid",
    })),
    ...manual.rows.map((m) => ({
      kind: "qr" as const, id: m.id, method: m.qr_mode === "dynamic" ? "Fonepay QR (automatic)" : "QR transfer (verified by staff)",
      amountNpr: Number(m.amount_paisa) / 100, credits: Number(m.credits), reference: m.reference, status: m.status,
      createdAt: iso(m.created_at), paidAt: m.status === "approved" && m.decided_at ? iso(m.decided_at) : null, receipt: m.status === "approved",
    })),
  ];
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface Receipt {
  number: string;
  issuedAt: string;
  customerPhone: string;
  customerName: string | null;
  method: string;
  amountNpr: number;
  credits: number;
  reference: string;
  bankReference: string | null;
}

/** Receipt for a completed top-up owned by the user (or any, for staff when ownerId is null). */
export async function getReceipt(kind: "khalti" | "qr", id: string, ownerId: string | null, db: Db = getDb()): Promise<Receipt | null> {
  if (kind === "khalti") {
    const { rows } = await db.query<{ order_reference: string; paid_at: unknown; amount_paisa: string; credits: string; gateway: string; verified_transaction_id: string | null; phone_e164: string; display_name: string | null; user_id: string }>(
      `select o.order_reference, o.paid_at, o.amount_paisa::text, o.credits::text, o.gateway, o.verified_transaction_id, u.phone_e164, u.display_name, o.user_id
         from payment_orders o join users u on u.id = o.user_id where o.id = $1 and o.status = 'paid'`,
      [id],
    );
    const r = rows[0];
    if (!r || (ownerId && r.user_id !== ownerId)) return null;
    return {
      number: `NBR-${r.order_reference}`, issuedAt: iso(r.paid_at ?? new Date()), customerPhone: r.phone_e164, customerName: r.display_name,
      method: r.gateway === "khalti" ? "Khalti" : r.gateway, amountNpr: Number(r.amount_paisa) / 100, credits: Number(r.credits), reference: r.order_reference, bankReference: r.verified_transaction_id,
    };
  }
  const { rows } = await db.query<{ reference: string; decided_at: unknown; amount_paisa: string; credits: string; verified_bank_ref: string | null; qr_mode: string; phone_e164: string; display_name: string | null; user_id: string }>(
    `select m.reference, m.decided_at, m.amount_paisa::text, m.credits::text, m.verified_bank_ref, m.qr_mode, u.phone_e164, u.display_name, m.user_id
       from manual_topup_requests m join users u on u.id = m.user_id where m.id = $1 and m.status = 'approved'`,
    [id],
  );
  const r = rows[0];
  if (!r || (ownerId && r.user_id !== ownerId)) return null;
  return {
    number: `NBR-${r.reference}`, issuedAt: iso(r.decided_at ?? new Date()), customerPhone: r.phone_e164, customerName: r.display_name,
    method: r.qr_mode === "dynamic" ? "Fonepay QR" : "QR bank transfer", amountNpr: Number(r.amount_paisa) / 100, credits: Number(r.credits), reference: r.reference, bankReference: r.verified_bank_ref,
  };
}
