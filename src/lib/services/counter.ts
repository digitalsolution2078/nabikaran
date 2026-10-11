import { getDb, type Db } from "../db";
import { HttpError } from "../core/errors";
import { normalizeNepalPhone } from "../phone";
import { readWallet } from "../core/wallet";
import { getSetting, creditsForNpr } from "./settings";
import { newPaymentReference, afterPaid } from "./manual-topups";
import { createPendingGiftCode, giftRules, validateGiftAmount } from "./credit-codes";
import { sendPushToUser } from "./push";

/**
 * Counter: staff (role counter, finance, admin or super admin) take cash or a
 * payment in person and either credit a registered customer's wallet or sell a
 * printed gift card. Each entry is an approved top-up row (source 'counter') with
 * the staff member, payment method and receipt number, so the cash drawer can be
 * reconciled per person per day. Staff cannot credit their own wallet, and
 * non-super-admins have a daily limit (Admin → Settings, "codes").
 */
export const COUNTER_METHODS = ["cash", "esewa", "khalti", "fonepay", "bank", "other"] as const;
export type CounterMethod = (typeof COUNTER_METHODS)[number];

export interface CounterCustomer {
  id: string;
  phone: string;
  name: string | null;
  available: number;
}

export async function counterLookup(phone: string, db: Db = getDb()): Promise<CounterCustomer> {
  const e164 = normalizeNepalPhone(phone);
  if (!e164) throw new HttpError(400, "Enter a valid Nepali mobile number.", "invalid_phone");
  const { rows } = await db.query<{ id: string; display_name: string | null; status: string }>("select id, display_name, status from users where phone_e164 = $1", [e164]);
  if (!rows[0] || rows[0].status !== "active") throw new HttpError(404, "No active Nabikaran account for this number. Ask the customer to sign up first.", "customer_not_found");
  const w = await readWallet(rows[0].id, db);
  return { id: rows[0].id, phone: e164, name: rows[0].display_name, available: w.available };
}

interface CounterInput {
  amountNpr: number;
  method: CounterMethod;
  receipt?: string | null;
  note?: string | null;
  idempotencyKey: string;
}

function mapError(e: unknown): never {
  const m = (e as Error).message ?? "";
  if (/daily counter limit/.test(m)) throw new HttpError(403, m.replace(/^error:\s*/i, "").replace(/^./, (c) => c.toUpperCase()) + " for today.", "daily_limit");
  if (/manual_topups_bank_ref_unique|duplicate key/.test(m)) throw new HttpError(409, "This receipt number was already used. Check it and try again.", "receipt_used");
  if (/own wallet/.test(m)) throw new HttpError(403, "You cannot top up your own wallet. Ask a colleague.", "self_topup");
  if (/only counter staff|customer not found|amount must/.test(m)) throw new HttpError(400, m.replace(/^error:\s*/i, ""), "counter_refused");
  throw e;
}

async function run(admin: { id: string }, userId: string, credits: number, input: CounterInput, giftCode: string | null, db: Db): Promise<{ id: string; reference: string }> {
  if (!Number.isInteger(input.amountNpr) || input.amountNpr < 1 || input.amountNpr > 1000000) throw new HttpError(400, "Enter a whole rupee amount.", "invalid_amount");
  if (!COUNTER_METHODS.includes(input.method)) throw new HttpError(400, "Choose how the customer paid.", "invalid_method");
  const receipt = input.receipt?.trim() || null;
  if (receipt && (receipt.length < 3 || receipt.length > 40)) throw new HttpError(400, "Receipt number is 3–40 characters.", "invalid_receipt");
  const limit = (await getSetting("codes", db)).counter_daily_limit_npr;
  const reference = `CT${newPaymentReference().slice(2)}`;
  try {
    const id = await db.tx(async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select counter_topup($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as id", [
        admin.id, userId, input.amountNpr, credits, input.method, receipt, input.note?.trim().slice(0, 300) || null, reference, input.idempotencyKey, limit, giftCode,
      ]);
      return rows[0].id;
    });
    const { rows } = await db.query<{ reference: string }>("select reference from manual_topup_requests where id = $1", [id]);
    return { id, reference: rows[0].reference };
  } catch (e) {
    mapError(e);
  }
}

/** Credit a customer's wallet for money taken at the counter. */
export async function counterTopup(admin: { id: string }, input: CounterInput & { phone: string }, db: Db = getDb()) {
  const customer = await counterLookup(input.phone, db);
  const credits = creditsForNpr(input.amountNpr);
  const r = await run(admin, customer.id, credits, input, null, db);
  await afterPaid(r.id, db);
  await sendPushToUser(customer.id, { title: "Credits added", body: `${credits} credits were added to your Nabikaran wallet (NPR ${input.amountNpr}).`, url: "/wallet", tag: "topup" }, db).catch(() => 0);
  return { ...r, credits, customer: { ...customer, available: (await readWallet(customer.id, db)).available } };
}

/** Sell a gift card for money taken at the counter. The code is shown once to print or hand over. */
export async function counterSellGift(admin: { id: string }, input: CounterInput & { toName?: string | null; message?: string | null }, db: Db = getDb()) {
  validateGiftAmount(input.amountNpr, await giftRules(db));
  const credits = creditsForNpr(input.amountNpr);
  const pending = await createPendingGiftCode({ credits, fromUserId: null, createdBy: admin.id, toName: input.toName, message: input.message }, db);
  try {
    const r = await run(admin, admin.id, credits, input, pending.id, db);
    // A replayed request returns the first sale; this new pending code is then unused.
    const { rows } = await db.query<{ gift_code_id: string }>("select gift_code_id from manual_topup_requests where id = $1", [r.id]);
    if (rows[0].gift_code_id !== pending.id) {
      await db.query("delete from credit_codes where id = $1 and status = 'pending'", [pending.id]);
      throw new HttpError(409, "This sale was already recorded. Find its code in today's list.", "duplicate_sale");
    }
    return { ...r, credits, code: pending.code };
  } catch (e) {
    await db.query("delete from credit_codes where id = $1 and status = 'pending'", [pending.id]).catch(() => undefined);
    throw e;
  }
}

export interface CounterEntry {
  id: string;
  reference: string;
  at: string;
  amountNpr: number;
  method: string;
  receipt: string | null;
  kind: "wallet" | "gift";
  customer: string | null;
  staff: string;
}

/** A Nepal day's counter entries (one staff member, or everyone) with totals per payment method. */
export async function counterLog(opts: { staffId: string | null; day?: string }, db: Db = getDb()): Promise<{ day: string; entries: CounterEntry[]; totals: Array<{ method: string; amountNpr: number; count: number }>; totalNpr: number }> {
  const day = opts.day && /^\d{4}-\d{2}-\d{2}$/.test(opts.day) ? opts.day : new Date(Date.now() + 345 * 60_000).toISOString().slice(0, 10);
  const { rows } = await db.query<{ id: string; reference: string; decided_at: string; amount_paisa: string; payment_method: string | null; verified_bank_ref: string | null; purpose: "wallet" | "gift"; customer: string | null; staff: string }>(
    `select m.id, m.reference, m.decided_at, m.amount_paisa::text, m.payment_method, m.verified_bank_ref, m.purpose,
            case when m.purpose = 'gift' then null else u.phone_e164 end as customer, coalesce(s.display_name, s.phone_e164) as staff
       from manual_topup_requests m join users u on u.id = m.user_id left join users s on s.id = m.decided_by
      where m.source = 'counter' and m.status = 'approved' and ($1::uuid is null or m.decided_by = $1::uuid)
        and m.decided_at >= ($2::date::timestamp at time zone 'Asia/Kathmandu') and m.decided_at < (($2::date + 1)::timestamp at time zone 'Asia/Kathmandu')
      order by m.decided_at desc limit 500`,
    [opts.staffId, day],
  );
  const entries = rows.map((r) => ({
    id: r.id, reference: r.reference, at: new Date(r.decided_at).toISOString(), amountNpr: Number(r.amount_paisa) / 100, method: r.payment_method ?? "cash",
    receipt: r.verified_bank_ref && r.verified_bank_ref !== r.reference ? r.verified_bank_ref : null, kind: r.purpose, customer: r.customer, staff: r.staff,
  }));
  const map = new Map<string, { method: string; amountNpr: number; count: number }>();
  for (const e of entries) {
    const t = map.get(e.method) ?? { method: e.method, amountNpr: 0, count: 0 };
    t.amountNpr += e.amountNpr;
    t.count++;
    map.set(e.method, t);
  }
  return { day, entries, totals: [...map.values()].sort((a, b) => b.amountNpr - a.amountNpr), totalNpr: entries.reduce((x, e) => x + e.amountNpr, 0) };
}
