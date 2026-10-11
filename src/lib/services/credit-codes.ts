import { createHash, randomInt } from "node:crypto";
import { getDb, type Db } from "../db";
import { HttpError } from "../core/errors";
import { audit } from "../core/audit";
import { retryAwaitingCredits } from "../core/wallet";
import { decryptSecret, encryptSecret } from "./secrets";
import { getSetting } from "./settings";
import { sendPushToUser } from "./push";

/**
 * Credit codes:
 *  - coupons  made by an admin: a batch of single-use codes (print / send one per
 *             customer) or one shared promo code (e.g. DASHAIN50) with a use limit;
 *  - gift cards bought with money (QR / Fonepay, or cash at the counter), like a
 *             top-up, and usable only once that payment is confirmed. Wallet
 *             credits can never be moved from one customer to another.
 * Codes are looked up by hash and stored encrypted. Each customer can redeem a
 * given code once. Credits never turn back into money.
 */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O, 1/I
const who = (userId: string) => ({ userId, via: "web" as const, scopes: [], locale: "en" });

/** Upper-case, drop spaces and dashes: "nb4k-7q2x" == "NB4K7Q2X". */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, "");
}

export function hashCode(code: string): string {
  return createHash("sha256").update(`nabikaran-code|${normalizeCode(code)}`).digest("hex");
}

/** 12 random characters (60 bits) shown as XXXX-XXXX-XXXX. */
export function generateCode(): string {
  let s = "";
  for (let i = 0; i < 12; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** Format a stored (normalized) code for display. */
export function displayCode(code: string): string {
  const n = normalizeCode(code);
  return n.length === 12 && /^[A-Z0-9]+$/.test(n) && [...n].every((c) => ALPHABET.includes(c)) ? `${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8)}` : n;
}

const hint = (code: string) => normalizeCode(code).slice(-4);

function mapError(e: unknown): never {
  const m = (e as Error).message ?? "";
  if (/code_invalid|code_not_found/.test(m)) throw new HttpError(404, "This code is not valid. Check it and try again.", "code_invalid");
  if (/code_already_redeemed/.test(m)) throw new HttpError(409, "You have already used this code.", "code_already_redeemed");
  if (/code_used/.test(m)) throw new HttpError(409, "This code has already been used.", "code_used");
  if (/code_expired/.test(m)) throw new HttpError(410, "This code has expired.", "code_expired");
  if (/credit_codes_code_hash_key|duplicate key/.test(m)) throw new HttpError(409, "That code already exists. Choose another.", "code_exists");
  throw e;
}

// ---- redeem ---------------------------------------------------------------

export interface RedeemResult {
  credits: number;
  source: "admin" | "gift";
  fromName: string | null;
  message: string | null;
}

export async function redeemCode(userId: string, code: string, db: Db = getDb()): Promise<RedeemResult> {
  const n = normalizeCode(code);
  if (n.length < 4 || n.length > 24 || !/^[A-Z0-9]+$/.test(n)) throw new HttpError(404, "This code is not valid. Check it and try again.", "code_invalid");
  let out: { credits: number; source: "admin" | "gift"; codeId: string; from: string | null };
  try {
    out = await db.tx(async (tx) => {
      const { rows } = await tx.query<{ r: { credits: number; source: "admin" | "gift"; codeId: string; from: string | null } }>("select credit_code_redeem($1, $2) as r", [userId, hashCode(n)]);
      return rows[0].r;
    });
  } catch (e) {
    mapError(e);
  }
  const { rows } = await db.query<{ name: string | null; message: string | null }>(
    "select u.display_name as name, c.gift_message as message from credit_codes c left join users u on u.id = c.gift_from_user where c.id = $1",
    [out.codeId],
  );
  await audit(db, who(userId), "wallet.code_redeemed", { type: "credit_code", id: out.codeId }, { credits: Number(out.credits), source: out.source });
  await retryAwaitingCredits(userId, db).catch(() => 0);
  if (out.source === "gift" && out.from) {
    await sendPushToUser(out.from, { title: "Gift card used", body: `Your Nabikaran gift card of ${out.credits} credits was redeemed.`, url: "/wallet/gifts", tag: "gift" }, db).catch(() => 0);
  }
  return { credits: Number(out.credits), source: out.source, fromName: out.source === "gift" ? rows[0]?.name ?? null : null, message: out.source === "gift" ? rows[0]?.message ?? null : null };
}

// ---- gift cards (bought with money) ---------------------------------------------

export interface GiftCard {
  id: string;
  /** Shown only once paid (status active). */
  code: string | null;
  credits: number;
  toName: string | null;
  message: string | null;
  status: "pending" | "active" | "used" | "cancelled" | "disabled";
  createdAt: string;
  usedAt: string | null;
  /** The payment request to finish while pending. */
  requestId: string | null;
}

export async function giftRules(db: Db = getDb()) {
  const s = await getSetting("codes", db);
  return { enabled: s.gifts_enabled, min: s.gift_min_npr, max: s.gift_max_npr };
}

/**
 * Make a gift card that is not usable yet (status pending). It becomes active
 * only when its payment is confirmed (approve_manual_topup / Fonepay / counter).
 */
export async function createPendingGiftCode(
  input: { credits: number; fromUserId: string | null; createdBy: string; toName?: string | null; message?: string | null },
  db: Db,
): Promise<{ id: string; code: string }> {
  const code = generateCode();
  const toName = input.toName?.trim().slice(0, 60) || null;
  const message = input.message?.trim().slice(0, 200) || null;
  const { rows } = await db.query<{ id: string }>(
    `insert into credit_codes (source, code_hash, code_enc, code_hint, credits, max_redemptions, status, created_by, gift_from_user, gift_to_name, gift_message)
     values ('gift', $1, $2, $3, $4, 1, 'pending', $5, $6, $7, $8) returning id`,
    [hashCode(code), encryptSecret(normalizeCode(code)), hint(code), input.credits, input.createdBy, input.fromUserId, toName, message],
  );
  return { id: rows[0].id, code: displayCode(code) };
}

export function validateGiftAmount(npr: number, rules: { enabled: boolean; min: number; max: number }): void {
  if (!rules.enabled) throw new HttpError(400, "Gift cards are not available right now.", "gifts_disabled");
  if (!Number.isInteger(npr) || npr < rules.min || npr > rules.max) throw new HttpError(400, `A gift card can be NPR ${rules.min}–${rules.max}.`, "invalid_amount");
}

export async function listMyGiftCards(userId: string, db: Db = getDb()): Promise<GiftCard[]> {
  const { rows } = await db.query<{ id: string; code_enc: string; credits: string; gift_to_name: string | null; gift_message: string | null; status: GiftCard["status"]; created_at: string; used_at: string | null; request_id: string | null }>(
    `select c.id, c.code_enc, c.credits::text, c.gift_to_name, c.gift_message, c.status, c.created_at,
            (select max(r.created_at) from credit_code_redemptions r where r.code_id = c.id) as used_at,
            (select m.id from manual_topup_requests m where m.gift_code_id = c.id order by m.created_at desc limit 1) as request_id
       from credit_codes c where c.source = 'gift' and c.gift_from_user = $1 order by c.created_at desc limit 100`,
    [userId],
  );
  return rows.map((r) => {
    const plain = r.status === "active" ? decryptSecret(r.code_enc) : null;
    return {
      id: r.id, code: plain ? displayCode(plain) : null, credits: Number(r.credits), toName: r.gift_to_name, message: r.gift_message, status: r.status,
      createdAt: new Date(r.created_at).toISOString(), usedAt: r.used_at ? new Date(r.used_at).toISOString() : null, requestId: r.request_id,
    };
  });
}

// ---- coupons (admin) ----------------------------------------------------------

export interface CouponBatch {
  id: string;
  name: string;
  kind: "single" | "shared";
  credits: number;
  codeCount: number;
  maxRedemptions: number;
  redeemed: number;
  creditsIssued: number;
  expiresAt: string | null;
  status: "active" | "disabled";
  createdAt: string;
  createdBy: string | null;
  /** Shared promo code (shown to admins). */
  sharedCode: string | null;
}

export interface CreateBatchInput {
  name: string;
  kind: "single" | "shared";
  credits: number;
  count?: number;
  maxRedemptions?: number;
  expiresAt?: string | null;
  /** Shared codes only: a chosen word like DASHAIN50 (else generated). */
  code?: string | null;
}

export async function createCouponBatch(admin: { id: string }, input: CreateBatchInput, db: Db = getDb()): Promise<{ batch: CouponBatch; codes: string[] }> {
  const name = input.name.trim();
  if (name.length < 3 || name.length > 80) throw new HttpError(400, "Give the batch a name (3–80 characters).", "invalid_name");
  if (!Number.isInteger(input.credits) || input.credits < 1 || input.credits > 100000) throw new HttpError(400, "Credits per code must be 1–100,000.", "invalid_credits");
  const expires = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expires && (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now())) throw new HttpError(400, "The expiry must be in the future.", "invalid_expiry");
  const count = input.kind === "single" ? input.count ?? 1 : 1;
  if (!Number.isInteger(count) || count < 1 || count > 5000) throw new HttpError(400, "Make 1–5,000 codes at a time.", "invalid_count");
  const maxRedemptions = input.kind === "shared" ? input.maxRedemptions ?? 100 : 1;
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1 || maxRedemptions > 1000000) throw new HttpError(400, "Use limit must be 1–1,000,000.", "invalid_limit");
  let codes: string[];
  if (input.kind === "shared" && input.code?.trim()) {
    const c = normalizeCode(input.code);
    if (!/^[A-Z0-9]{4,20}$/.test(c)) throw new HttpError(400, "A promo code is 4–20 letters and numbers.", "invalid_code");
    codes = [c];
  } else {
    const set = new Set<string>();
    while (set.size < count) set.add(generateCode());
    codes = [...set];
  }
  let batchId: string;
  try {
    batchId = await db.tx(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "insert into credit_code_batches (name, kind, credits, code_count, max_redemptions, expires_at, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id",
        [name, input.kind, input.credits, codes.length, maxRedemptions, expires?.toISOString() ?? null, admin.id],
      );
      const id = rows[0].id;
      for (let i = 0; i < codes.length; i += 500) {
        const chunk = codes.slice(i, i + 500);
        const params: unknown[] = [];
        const values = chunk.map((c, j) => {
          params.push(hashCode(c), encryptSecret(normalizeCode(c)), hint(c));
          return `('admin', '${id}', $${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3}, ${input.credits}, ${maxRedemptions}, ${expires ? `'${expires.toISOString()}'::timestamptz` : "null"}, '${admin.id}')`;
        });
        await tx.query(
          `insert into credit_codes (source, batch_id, code_hash, code_enc, code_hint, credits, max_redemptions, expires_at, created_by) values ${values.join(",")}`,
          params,
        );
      }
      return id;
    });
  } catch (e) {
    mapError(e);
  }
  await audit(db, who(admin.id), "coupons.batch_created", { type: "credit_code_batch", id: batchId }, { name, kind: input.kind, credits: input.credits, count: codes.length, maxRedemptions });
  const batch = (await listCouponBatches(db)).find((b) => b.id === batchId)!;
  return { batch, codes: codes.map(displayCode) };
}

export async function listCouponBatches(db: Db = getDb()): Promise<CouponBatch[]> {
  const { rows } = await db.query<{ id: string; name: string; kind: "single" | "shared"; credits: string; code_count: number; max_redemptions: number; redeemed: string; issued: string; expires_at: string | null; status: "active" | "disabled"; created_at: string; created_by: string | null; shared_enc: string | null }>(
    `select b.id, b.name, b.kind, b.credits::text, b.code_count, b.max_redemptions, b.expires_at, b.status, b.created_at,
            coalesce(u.display_name, u.phone_e164) as created_by,
            (select count(*) from credit_code_redemptions r join credit_codes c on c.id = r.code_id where c.batch_id = b.id)::text as redeemed,
            (select coalesce(sum(r.credits), 0) from credit_code_redemptions r join credit_codes c on c.id = r.code_id where c.batch_id = b.id)::text as issued,
            case when b.kind = 'shared' then (select c.code_enc from credit_codes c where c.batch_id = b.id limit 1) end as shared_enc
       from credit_code_batches b left join users u on u.id = b.created_by
      order by b.created_at desc limit 200`,
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, kind: r.kind, credits: Number(r.credits), codeCount: r.code_count, maxRedemptions: r.max_redemptions,
    redeemed: Number(r.redeemed), creditsIssued: Number(r.issued), expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    status: r.status, createdAt: new Date(r.created_at).toISOString(), createdBy: r.created_by,
    sharedCode: r.shared_enc ? displayCode(decryptSecret(r.shared_enc) ?? "") || null : null,
  }));
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** CSV of a batch's codes (for printing or a mail merge). */
export async function couponBatchCsv(admin: { id: string }, batchId: string, db: Db = getDb()): Promise<{ filename: string; csv: string }> {
  const { rows: b } = await db.query<{ name: string }>("select name from credit_code_batches where id = $1", [batchId]);
  if (!b[0]) throw new HttpError(404, "Batch not found", "not_found");
  const { rows } = await db.query<{ code_enc: string; credits: string; status: string; redeemed_count: number; max_redemptions: number; expires_at: string | null }>(
    "select code_enc, credits::text, status, redeemed_count, max_redemptions, expires_at from credit_codes where batch_id = $1 order by created_at, code_hint",
    [batchId],
  );
  const lines = ["code,credits,status,used,limit,expires"];
  for (const r of rows) {
    const plain = decryptSecret(r.code_enc);
    lines.push([plain ? displayCode(plain) : "(unreadable)", r.credits, r.status, String(r.redeemed_count), String(r.max_redemptions), r.expires_at ? new Date(r.expires_at).toISOString().slice(0, 10) : ""].map(csvCell).join(","));
  }
  await audit(db, who(admin.id), "coupons.batch_downloaded", { type: "credit_code_batch", id: batchId }, { codes: rows.length });
  const slug = b[0].name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "coupons";
  return { filename: `nabikaran-${slug}.csv`, csv: lines.join("\n") + "\n" };
}

export async function setCouponBatchStatus(admin: { id: string }, batchId: string, status: "active" | "disabled", db: Db = getDb()): Promise<void> {
  const { rowCount } = await db.query("update credit_code_batches set status = $2 where id = $1", [batchId, status]);
  if (!rowCount) throw new HttpError(404, "Batch not found", "not_found");
  await audit(db, who(admin.id), status === "disabled" ? "coupons.batch_disabled" : "coupons.batch_enabled", { type: "credit_code_batch", id: batchId }, {});
}

/** Totals for the admin page: gift cards in circulation. */
export async function giftCardStats(db: Db = getDb()): Promise<{ active: number; activeCredits: number; used: number; cancelled: number }> {
  const { rows } = await db.query<{ status: string; n: string; credits: string }>(
    "select status, count(*)::text as n, coalesce(sum(credits), 0)::text as credits from credit_codes where source = 'gift' group by status",
  );
  const get = (s: string) => rows.find((r) => r.status === s);
  return { active: Number(get("active")?.n ?? 0), activeCredits: Number(get("active")?.credits ?? 0), used: Number(get("used")?.n ?? 0), cancelled: Number(get("cancelled")?.n ?? 0) };
}

