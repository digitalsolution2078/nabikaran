import { z } from "zod";
import { getDb, type Db } from "../db";
import { HttpError } from "../core/errors";
import { audit } from "../core/audit";
import { getActivePricing, roundCredits } from "../core/wallet";
import type { BonusTier } from "../bonus";

/**
 * Customer prices (credits per message; 1 credit = NPR 1) and top-up bonus tiers.
 * App notifications are always free.
 */
export interface ChannelPrices { sms: number; whatsapp: number; email: number }

export async function channelPrices(db: Db = getDb()): Promise<ChannelPrices> {
  const [sms, whatsapp, email] = await Promise.all([
    getActivePricing(db, "sms").then((p) => p.creditsPerUnit).catch(() => 1.5),
    getActivePricing(db, "whatsapp").then((p) => p.creditsPerUnit).catch(() => 1),
    getActivePricing(db, "email").then((p) => p.creditsPerUnit).catch(() => 0.3),
  ]);
  return { sms, whatsapp, email };
}

export async function listBonusTiers(db: Db = getDb()): Promise<BonusTier[]> {
  const { rows } = await db.query<{ min_npr: number; percent: string }>("select min_npr, percent::text from topup_bonus_tiers order by min_npr");
  return rows.map((r) => ({ minNpr: Number(r.min_npr), percent: Number(r.percent) }));
}

export const bonusTiersSchema = z.array(z.object({
  minNpr: z.number().int().min(1).max(1000000),
  percent: z.number().min(0.01).max(50),
})).max(8);

/** Replace all tiers (empty list = no bonus). Super admin (settings.manage). */
export async function saveBonusTiers(actorId: string, raw: unknown, db: Db = getDb()): Promise<BonusTier[]> {
  const tiers = bonusTiersSchema.parse(raw).map((t) => ({ minNpr: t.minNpr, percent: roundCredits(t.percent) }));
  if (new Set(tiers.map((t) => t.minNpr)).size !== tiers.length) throw new HttpError(400, "Each tier needs a different minimum amount.", "duplicate_tier");
  const sorted = [...tiers].sort((a, b) => a.minNpr - b.minNpr);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].percent <= sorted[i - 1].percent) throw new HttpError(400, "A bigger top-up must get a bigger bonus percentage.", "tier_order");
  }
  await db.tx(async (tx) => {
    await tx.query("delete from topup_bonus_tiers");
    for (const t of sorted) await tx.query("insert into topup_bonus_tiers (min_npr, percent, updated_by) values ($1,$2,$3)", [t.minNpr, t.percent, actorId]);
    await audit(tx, { userId: actorId, via: "web", scopes: [], locale: "en" }, "pricing.bonus_tiers", null, { tiers: sorted });
  });
  return sorted;
}

export interface ChannelUsage { channel: "sms" | "whatsapp" | "email"; messages: number; credits: number }

/** Credits a customer spent per channel (charges minus refunds), all time and this calendar month (Nepal time). */
export async function usageByChannel(userId: string, db: Db = getDb()): Promise<{ allTime: ChannelUsage[]; thisMonth: ChannelUsage[] }> {
  const { rows } = await db.query<{ channel: string; month: boolean; messages: number; credits: string }>(
    `select coalesce(j.channel, 'sms') as channel,
            (l.created_at >= (date_trunc('month', now() at time zone 'Asia/Kathmandu') at time zone 'Asia/Kathmandu')) as month,
            count(*) filter (where l.type = 'debit')::int as messages,
            (-sum(l.signed_credits))::text as credits
       from wallet_ledger l join reminder_jobs j on j.id::text = l.reference_id
      where l.user_id = $1 and l.reference_type = 'reminder_job' and l.type in ('debit','reversal')
      group by 1, 2`,
    [userId],
  );
  const sum = (filter: (r: (typeof rows)[number]) => boolean) =>
    (["sms", "whatsapp", "email"] as const).map((ch) => {
      const rs = rows.filter((r) => r.channel === ch && filter(r));
      return { channel: ch, messages: rs.reduce((n, r) => n + r.messages, 0), credits: roundCredits(rs.reduce((n, r) => n + Number(r.credits), 0)) };
    });
  return { allTime: sum(() => true), thisMonth: sum((r) => r.month) };
}
