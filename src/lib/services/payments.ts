import { createHash, randomBytes } from "node:crypto";
import { getDb, type Db } from "../db";
import { getPaymentGateway, type LookupResult } from "../payments";
import { env } from "../env";
import { HttpError } from "../core/errors";
import { retryAwaitingCredits } from "../core/wallet";
import { validateTopupAmount } from "./settings";

export interface PackRow {
  code: string;
  amount_paisa: string | number;
  credits: string | number;
}

export interface OrderRow {
  id: string;
  user_id: string;
  gateway: string;
  order_reference: string;
  pack_code: string | null;
  amount_paisa: string | number;
  credits: string | number;
  status: string;
  gateway_ref: string | null;
  verified_transaction_id: string | null;
  payment_url: string | null;
  created_at: string;
  paid_at: string | null;
}

export async function listPacks(db: Db = getDb()): Promise<PackRow[]> {
  const { rows } = await db.query<PackRow>("select code, amount_paisa, credits from topup_packs where active order by sort_order");
  return rows;
}

function newOrderReference(): string {
  return `NB-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * Create an immutable server-side order from an offered pack and start
 * gateway checkout. Amount and credits come from the pack table, never the client.
 */
export async function createTopupOrder(user: { id: string; phoneE164: string }, packCode: string, db: Db = getDb()) {
  const { rows: packs } = await db.query<PackRow>("select code, amount_paisa, credits from topup_packs where code = $1 and active", [packCode]);
  const pack = packs[0];
  if (!pack) throw new HttpError(400, "Unknown pack", "unknown_pack");
  return createOrder(user, Number(pack.amount_paisa), Number(pack.credits), pack.code, db);
}

/** Customer-chosen amount (whole NPR), validated against admin min/max. 1 credit = NPR 1. */
export async function createCustomTopupOrder(user: { id: string; phoneE164: string }, amountNpr: number, db: Db = getDb()) {
  const { amountPaisa, credits } = await validateTopupAmount(amountNpr, db);
  return createOrder(user, amountPaisa, credits, null, db);
}

async function createOrder(user: { id: string; phoneE164: string }, amountPaisa: number, credits: number, packCode: string | null, db: Db) {
  const gateway = getPaymentGateway();
  const orderReference = newOrderReference();
  const { rows } = await db.query<OrderRow>(
    `insert into payment_orders (user_id, gateway, order_reference, pack_code, amount_paisa, credits, status)
     values ($1,$2,$3,$4,$5,$6,'initiated') returning *`,
    [user.id, gateway.name, orderReference, packCode, amountPaisa, credits],
  );
  const order = rows[0];
  const init = await gateway.initiate({
    orderId: order.id,
    orderReference,
    amountPaisa,
    description: `Nabikaran wallet ${credits} credits`,
    returnUrl: `${env.appUrl}/api/payments/${gateway.name}/return`,
    websiteUrl: env.appUrl,
    customer: { phone: user.phoneE164 },
  });
  await db.query("update payment_orders set gateway_ref = $2, payment_url = $3, status = 'pending', updated_at = now() where id = $1", [
    order.id, init.gatewayRef, init.paymentUrl,
  ]);
  return { orderId: order.id, orderReference, paymentUrl: init.paymentUrl, gatewayRef: init.gatewayRef };
}

export type ConfirmOutcome =
  | { result: "credited"; orderId: string; credits: number }
  | { result: "already_credited"; orderId: string }
  | { result: "not_completed"; orderId: string | null; status: LookupResult["status"] }
  | { result: "mismatch"; orderId: string; reason: string };

/**
 * Confirm a payment by gateway reference. Safe to call any number of times
 * (return URL, webhook, reconciliation). Credits are issued exactly once and
 * only when lookup says Completed AND amount/order match our record.
 */
export async function confirmPaymentByRef(gatewayName: string, gatewayRef: string, db: Db = getDb()): Promise<ConfirmOutcome> {
  const gateway = getPaymentGateway();
  if (gateway.name !== gatewayName) throw new HttpError(400, "Gateway mismatch");
  const { rows } = await db.query<OrderRow>("select * from payment_orders where gateway = $1 and gateway_ref = $2", [gatewayName, gatewayRef]);
  const order = rows[0];
  if (!order) throw new HttpError(404, "Unknown payment reference", "unknown_order");
  if (order.status === "paid") return { result: "already_credited", orderId: order.id };

  const lookup = await gateway.lookup(gatewayRef);
  const payloadHash = createHash("sha256").update(JSON.stringify(lookup.raw ?? lookup)).digest("hex");
  await db.query(
    `insert into payment_events (payment_order_id, gateway_event_id, payload_hash, event_type, payload)
     values ($1, $2, $3, $4, $5) on conflict (gateway_event_id) do nothing`,
    [order.id, lookup.transactionId ? `${gatewayName}:${lookup.transactionId}:${lookup.status}` : null, payloadHash, `lookup.${lookup.status}`, JSON.stringify(lookup.raw ?? null)],
  );

  if (lookup.status !== "completed") {
    if (["expired", "canceled", "failed"].includes(lookup.status) && order.status !== "paid") {
      await db.query("update payment_orders set status = $2, updated_at = now() where id = $1 and status in ('initiated','pending')", [
        order.id, lookup.status === "canceled" ? "cancelled" : lookup.status,
      ]);
    }
    return { result: "not_completed", orderId: order.id, status: lookup.status };
  }
  if (lookup.amountPaisa === null || Number(lookup.amountPaisa) !== Number(order.amount_paisa)) {
    await db.query("insert into audit_events (action, target_type, target_id, json_detail_redacted) values ('payment.amount_mismatch','payment_order',$1,$2)", [
      order.id, JSON.stringify({ expected: Number(order.amount_paisa), got: lookup.amountPaisa }),
    ]);
    return { result: "mismatch", orderId: order.id, reason: "amount" };
  }
  if (lookup.orderReference && lookup.orderReference !== order.order_reference) {
    return { result: "mismatch", orderId: order.id, reason: "order_reference" };
  }
  if (!lookup.transactionId) return { result: "mismatch", orderId: order.id, reason: "missing_transaction_id" };

  const credited = await db.tx(async (tx) => {
    const { rows: r } = await tx.query<{ wallet_apply_topup: boolean }>("select wallet_apply_topup($1, $2)", [order.id, lookup.transactionId]);
    return r[0].wallet_apply_topup;
  });
  if (!credited) return { result: "already_credited", orderId: order.id };
  await retryAwaitingCredits(order.user_id, db);
  return { result: "credited", orderId: order.id, credits: Number(order.credits) };
}

export async function listOrders(userId: string, db: Db = getDb()): Promise<OrderRow[]> {
  const { rows } = await db.query<OrderRow>("select * from payment_orders where user_id = $1 order by created_at desc limit 50", [userId]);
  return rows;
}

/** Reconcile every pending order older than a few minutes (cron). */
export async function reconcilePendingOrders(db: Db = getDb()): Promise<{ checked: number; credited: number }> {
  const { rows } = await db.query<OrderRow>(
    "select * from payment_orders where status in ('initiated','pending') and gateway_ref is not null and created_at < now() - interval '2 minutes' and created_at > now() - interval '7 days' order by created_at limit 100",
  );
  let credited = 0;
  for (const o of rows) {
    try {
      const out = await confirmPaymentByRef(o.gateway, o.gateway_ref!, db);
      if (out.result === "credited") credited++;
    } catch (e) {
      console.warn(`[payments] reconcile ${o.id} failed: ${(e as Error).message}`);
    }
  }
  return { checked: rows.length, credited };
}
