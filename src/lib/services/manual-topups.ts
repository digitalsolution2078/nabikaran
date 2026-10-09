import { randomBytes } from "node:crypto";
import { getDb, type Db } from "../db";
import { audit } from "../core/audit";
import { HttpError } from "../core/errors";
import { retryAwaitingCredits } from "../core/wallet";
import { getSetting, validateTopupAmount } from "./settings";

/**
 * Manual QR top-ups (docs/ADMIN_AND_PAYMENTS.md).
 *
 * The configured QR is a STATIC Fonepay merchant QR (EMVCo tag 01 = "11"); it
 * carries no amount or remark, so the amount and a unique reference are shown
 * next to it. Credits are issued only when an admin matches the payment in the
 * bank / merchant statement and records that statement's reference
 * (approve_manual_topup, idempotent, one bank reference → one approval).
 */
export interface ManualTopup {
  id: string;
  reference: string;
  amountNpr: number;
  credits: number;
  status: "awaiting_payment" | "pending" | "approved" | "rejected" | "cancelled";
  payerTxnRef: string | null;
  payerNote: string | null;
  hasReceipt: boolean;
  submittedAt: string | null;
  decidedAt: string | null;
  decisionNotes: string | null;
  createdAt: string;
}

interface Row {
  id: string; reference: string; amount_paisa: string | number; credits: string | number; status: ManualTopup["status"];
  payer_txn_ref: string | null; payer_note: string | null; has_receipt: boolean; submitted_at: string | null; decided_at: string | null;
  decision_notes: string | null; created_at: string;
}

function toDto(r: Row): ManualTopup {
  const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
  return {
    id: r.id, reference: r.reference, amountNpr: Number(r.amount_paisa) / 100, credits: Number(r.credits), status: r.status,
    payerTxnRef: r.payer_txn_ref, payerNote: r.payer_note, hasReceipt: r.has_receipt, submittedAt: iso(r.submitted_at),
    decidedAt: iso(r.decided_at), decisionNotes: r.decision_notes, createdAt: new Date(r.created_at).toISOString(),
  };
}

const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I/L

export function newPaymentReference(): string {
  const b = randomBytes(6);
  let s = "NB";
  for (const x of b) s += REF_ALPHABET[x % REF_ALPHABET.length];
  return s;
}

const MAX_OPEN_REQUESTS = 3;

/** Step 1: customer chose an amount and "Pay via QR". Returns the reference to show beside the QR. */
export async function startManualTopup(userId: string, amountNpr: number, db: Db = getDb()) {
  const qr = await getSetting("manual_qr", db);
  if (!qr.enabled) throw new HttpError(400, "QR top-up is currently unavailable", "qr_disabled");
  const { amountPaisa, credits } = await validateTopupAmount(amountNpr, db);
  const { rows: open } = await db.query<{ n: string }>(
    "select count(*)::text as n from manual_topup_requests where user_id = $1 and status in ('awaiting_payment','pending')",
    [userId],
  );
  if (Number(open[0].n) >= MAX_OPEN_REQUESTS) throw new HttpError(429, "You already have open QR top-up requests. Submit or cancel them first.", "too_many_open");
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = newPaymentReference();
    const { rows } = await db.query<Row>(
      "insert into manual_topup_requests (user_id, reference, amount_paisa, credits) values ($1,$2,$3,$4) on conflict (reference) do nothing returning *",
      [userId, reference, amountPaisa, credits],
    );
    if (rows[0]) {
      await audit(db, { userId, via: "web", scopes: [], locale: "en" }, "wallet.manual_topup_started", { type: "manual_topup", id: rows[0].id }, { amountPaisa, reference });
      return { request: toDto(rows[0]), qr };
    }
  }
  throw new HttpError(500, "Could not allocate a payment reference", "reference_exhausted");
}

/** Step 2: customer paid and submits their transaction ID (and optionally a receipt). */
export async function submitManualTopup(
  userId: string,
  requestId: string,
  input: { payerTxnRef: string; payerNote?: string | null; receipt?: { contentType: string; bytes: Buffer } | null },
  db: Db = getDb(),
): Promise<ManualTopup> {
  const txn = input.payerTxnRef.trim();
  if (txn.length < 4 || txn.length > 64) throw new HttpError(400, "Enter the transaction ID shown in your payment app", "invalid_txn_ref");
  if (input.receipt) {
    if (!["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(input.receipt.contentType)) throw new HttpError(400, "Receipt must be PNG, JPEG, WebP or PDF", "invalid_receipt");
    if (input.receipt.bytes.length > 3 * 1024 * 1024) throw new HttpError(400, "Receipt must be 3 MB or smaller", "receipt_too_large");
  }
  return db.tx(async (tx) => {
    const { rows } = await tx.query<Row & { user_id: string }>("select * from manual_topup_requests where id = $1 for update", [requestId]);
    const r = rows[0];
    if (!r || r.user_id !== userId) throw new HttpError(404, "Top-up request not found", "not_found");
    if (r.status === "pending" && r.payer_txn_ref === txn) return toDto(r); // idempotent resubmit
    if (r.status !== "awaiting_payment") throw new HttpError(409, `This request is already ${r.status}`, "invalid_state");
    if (input.receipt) {
      await tx.query(
        "insert into topup_receipts (request_id, content_type, size_bytes, bytes) values ($1,$2,$3,$4) on conflict (request_id) do update set content_type = excluded.content_type, size_bytes = excluded.size_bytes, bytes = excluded.bytes",
        [r.id, input.receipt.contentType, input.receipt.bytes.length, input.receipt.bytes],
      );
    }
    const { rows: upd } = await tx.query<Row>(
      `update manual_topup_requests set status = 'pending', payer_txn_ref = $2, payer_note = $3, has_receipt = has_receipt or $4, submitted_at = now()
        where id = $1 returning *`,
      [r.id, txn, input.payerNote?.trim().slice(0, 300) || null, Boolean(input.receipt)],
    );
    await audit(tx, { userId, via: "web", scopes: [], locale: "en" }, "wallet.manual_topup_submitted", { type: "manual_topup", id: r.id }, { payerTxnRef: txn, receipt: Boolean(input.receipt) });
    return toDto(upd[0]);
  });
}

export async function cancelManualTopup(userId: string, requestId: string, db: Db = getDb()): Promise<void> {
  const { rowCount } = await db.query(
    "update manual_topup_requests set status = 'cancelled' where id = $1 and user_id = $2 and status = 'awaiting_payment'",
    [requestId, userId],
  );
  if (!rowCount) throw new HttpError(409, "Only unpaid requests can be cancelled", "invalid_state");
}

export async function listMyManualTopups(userId: string, db: Db = getDb()): Promise<ManualTopup[]> {
  const { rows } = await db.query<Row>("select * from manual_topup_requests where user_id = $1 order by created_at desc limit 50", [userId]);
  return rows.map(toDto);
}

// ---------------------------------------------------------------------------
// Admin side
// ---------------------------------------------------------------------------
export interface AdminTopupRow extends ManualTopup {
  userId: string;
  userPhone: string;
  userName: string | null;
  decidedByPhone: string | null;
  verifiedBankRef: string | null;
}

export async function listTopupsForAdmin(status: "pending" | "approved" | "rejected" | "awaiting_payment" | "all", db: Db = getDb()): Promise<AdminTopupRow[]> {
  const { rows } = await db.query<Row & { user_id: string; phone_e164: string; display_name: string | null; decided_phone: string | null; verified_bank_ref: string | null }>(
    `select m.*, u.phone_e164, u.display_name, d.phone_e164 as decided_phone
       from manual_topup_requests m join users u on u.id = m.user_id left join users d on d.id = m.decided_by
      where ($1 = 'all' or m.status = $1)
      order by coalesce(m.submitted_at, m.created_at) desc limit 200`,
    [status],
  );
  return rows.map((r) => ({ ...toDto(r), userId: r.user_id, userPhone: r.phone_e164, userName: r.display_name, decidedByPhone: r.decided_phone, verifiedBankRef: r.verified_bank_ref }));
}

export async function approveManualTopup(adminId: string, requestId: string, bankRef: string, notes: string | null, db: Db = getDb()): Promise<{ credited: boolean }> {
  try {
    const credited = await db.tx(async (tx) => {
      const { rows } = await tx.query<{ approve_manual_topup: boolean }>("select approve_manual_topup($1, $2, $3, $4)", [requestId, adminId, bankRef, notes]);
      return rows[0].approve_manual_topup;
    });
    if (credited) {
      const { rows } = await db.query<{ user_id: string }>("select user_id from manual_topup_requests where id = $1", [requestId]);
      if (rows[0]) await retryAwaitingCredits(rows[0].user_id, db);
    }
    return { credited };
  } catch (e) {
    const msg = (e as Error).message;
    if (/manual_topups_bank_ref_unique|duplicate key/.test(msg)) throw new HttpError(409, "This bank/merchant reference was already used to approve another top-up", "bank_ref_used");
    if (/only|required|cannot|request is|not found/.test(msg)) throw new HttpError(400, msg.replace(/^error:\s*/i, ""), "approve_refused");
    throw e;
  }
}

export async function rejectManualTopup(adminId: string, requestId: string, reason: string, db: Db = getDb()): Promise<{ changed: boolean }> {
  try {
    const { rows } = await db.query<{ reject_manual_topup: boolean }>("select reject_manual_topup($1, $2, $3)", [requestId, adminId, reason]);
    return { changed: rows[0].reject_manual_topup };
  } catch (e) {
    const msg = (e as Error).message;
    if (/only|required|request is|not found/.test(msg)) throw new HttpError(400, msg, "reject_refused");
    throw e;
  }
}

export async function getReceipt(requestId: string, db: Db = getDb()): Promise<{ contentType: string; bytes: Buffer } | null> {
  const { rows } = await db.query<{ content_type: string; bytes: Buffer | Uint8Array }>("select content_type, bytes from topup_receipts where request_id = $1", [requestId]);
  if (!rows[0]) return null;
  return { contentType: rows[0].content_type, bytes: Buffer.from(rows[0].bytes) };
}
