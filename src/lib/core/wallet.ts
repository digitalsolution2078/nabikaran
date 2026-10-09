import { getDb, type Db } from "../db";
import { env } from "../env";
import { requireScope, type Principal } from "./principal";

export interface WalletView {
  posted: number;
  reserved: number;
  available: number;
}

export interface WalletSummary extends WalletView {
  creditValue: string;
  creditsPerSmsSegment: number;
  pricingVersion: number;
  /** Top-ups are completed on the website only; MCP clients hand the user this link. */
  topUpUrl: string;
}

export interface LedgerEntry {
  id: number;
  type: string;
  signedCredits: number;
  referenceType: string | null;
  referenceId: string | null;
  memo: string | null;
  createdAt: string;
}

/** Internal (no scope check): used by services that already own the user context. */
export async function readWallet(userId: string, db: Db = getDb()): Promise<WalletView> {
  const { rows } = await db.query<{ posted_balance_credits: string; reserved_credits: string }>(
    "select posted_balance_credits::text, reserved_credits::text from wallets where user_id = $1",
    [userId],
  );
  const posted = Number(rows[0]?.posted_balance_credits ?? 0);
  const reserved = Number(rows[0]?.reserved_credits ?? 0);
  return { posted, reserved, available: posted - reserved };
}

export async function getWallet(p: Principal, db: Db = getDb()): Promise<WalletView> {
  requireScope(p, "wallet:read");
  return readWallet(p.userId, db);
}

export async function getWalletSummary(p: Principal, db: Db = getDb()): Promise<WalletSummary> {
  requireScope(p, "wallet:read");
  const [w, pricing] = await Promise.all([readWallet(p.userId, db), getActivePricing(db)]);
  return {
    ...w,
    creditValue: "1 credit = NPR 1",
    creditsPerSmsSegment: pricing.creditsPerUnit,
    pricingVersion: pricing.id,
    topUpUrl: `${env.appUrl}/wallet`,
  };
}

export async function getLedger(p: Principal, limit = 50, db: Db = getDb()): Promise<LedgerEntry[]> {
  requireScope(p, "wallet:read");
  const { rows } = await db.query<{
    id: number | string; type: string; signed_credits: string; reference_type: string | null; reference_id: string | null; memo: string | null; created_at: string;
  }>(
    "select id, type, signed_credits::text, reference_type, reference_id, memo, created_at from wallet_ledger where user_id = $1 order by created_at desc, id desc limit $2",
    [p.userId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    type: r.type,
    signedCredits: Number(r.signed_credits),
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    memo: r.memo,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export type Channel = "sms" | "whatsapp";

/** Current price for a channel: credits per SMS unit, or per accepted WhatsApp template message. */
export async function getActivePricing(db: Db = getDb(), channel: Channel = "sms"): Promise<{ id: number; creditsPerUnit: number }> {
  const { rows } = await db.query<{ id: number | string; credits_per_billable_unit: number }>(
    "select id, credits_per_billable_unit from pricing_versions where channel = $1 and effective_at <= now() order by effective_at desc, id desc limit 1",
    [channel],
  );
  if (!rows[0]) throw new Error(`No active ${channel} pricing version`);
  return { id: Number(rows[0].id), creditsPerUnit: Number(rows[0].credits_per_billable_unit) };
}

/** Re-attempt reservations for jobs waiting on credits (after a top-up). Internal. */
export async function retryAwaitingCredits(userId: string, db: Db = getDb()): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    "select id from reminder_jobs where user_id = $1 and status = 'awaiting_credits' order by due_at_utc",
    [userId],
  );
  let scheduled = 0;
  for (const r of rows) {
    const { rows: res } = await db.query<{ wallet_reserve_for_job: string }>("select wallet_reserve_for_job($1)", [r.id]);
    if (res[0]?.wallet_reserve_for_job === "scheduled") scheduled++;
    else break; // earliest-first; if this one cannot be funded, later ones cannot either
  }
  return scheduled;
}
