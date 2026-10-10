import { randomInt } from "node:crypto";
import { getDb, type Db } from "../db";
import { getSetting, type ReferralSettings } from "./settings";

/**
 * Referral programme (admin settings key 'referral'):
 *  - every customer gets a short code; nabikaran.org/r/CODE remembers it for 30 days
 *  - a NEW account created through the link is recorded as referred (pending)
 *  - once the new customer's paid top-ups reach min_topup_npr, both sides get
 *    their bonus credits, exactly once (wallet_credit_referral is idempotent)
 *  - a referrer earns at most max_rewards_per_referrer rewards
 * Sign-ups alone earn nothing, so fake accounts cannot farm credits.
 */
export const REFERRAL_COOKIE = "nb_ref";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function normalizeCode(code: string | null | undefined): string | null {
  const c = (code ?? "").trim().toUpperCase();
  return /^[A-Z2-9]{6,10}$/.test(c) ? c : null;
}

export async function getOrCreateReferralCode(userId: string, db: Db = getDb()): Promise<string> {
  const { rows } = await db.query<{ referral_code: string | null }>("select referral_code from users where id = $1", [userId]);
  if (rows[0]?.referral_code) return rows[0].referral_code;
  for (let i = 0; i < 8; i++) {
    let code = "";
    for (let j = 0; j < 7; j++) code += ALPHABET[randomInt(ALPHABET.length)];
    try {
      const { rows: up } = await db.query<{ referral_code: string }>(
        "update users set referral_code = $2 where id = $1 and referral_code is null returning referral_code",
        [userId, code],
      );
      if (up[0]) return up[0].referral_code;
      const { rows: again } = await db.query<{ referral_code: string }>("select referral_code from users where id = $1", [userId]);
      if (again[0]?.referral_code) return again[0].referral_code;
    } catch {
      // unique collision: try another code
    }
  }
  throw new Error("could not allocate a referral code");
}

export async function referrerByCode(code: string, db: Db = getDb()): Promise<{ id: string; name: string | null } | null> {
  const c = normalizeCode(code);
  if (!c) return null;
  const { rows } = await db.query<{ id: string; display_name: string | null }>(
    "select id, display_name from users where referral_code = $1 and status = 'active' and phone_verified_at is not null",
    [c],
  );
  return rows[0] ? { id: rows[0].id, name: rows[0].display_name } : null;
}

/** Record that a just-created account came through a referral link. Safe to call more than once. */
export async function attachReferral(newUserId: string, code: string | null | undefined, db: Db = getDb()): Promise<boolean> {
  const s = await getSetting("referral", db);
  if (!s.enabled) return false;
  const referrer = code ? await referrerByCode(code, db) : null;
  if (!referrer || referrer.id === newUserId) return false;
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "update users set referred_by = $2, referred_at = now() where id = $1 and referred_by is null returning id",
      [newUserId, referrer.id],
    );
    if (!rows[0]) return false;
    await tx.query("insert into referral_rewards (referrer_id, referee_id) values ($1, $2) on conflict (referee_id) do nothing", [referrer.id, newUserId]);
    await tx.query("insert into audit_events (actor_user_id, action, target_type, target_id, json_detail_redacted) values ($1,'referral.signup','user',$2,$3)", [
      newUserId, newUserId, JSON.stringify({ referrer: referrer.id }),
    ]);
    return true;
  });
}

/**
 * Called after any paid top-up is credited. Pays both bonuses once the invited
 * customer's paid top-ups reach the threshold. Returns true when it paid.
 */
export async function rewardReferralIfQualified(userId: string, db: Db = getDb()): Promise<boolean> {
  const s = await getSetting("referral", db);
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ id: string; referrer_id: string }>(
      "select id, referrer_id from referral_rewards where referee_id = $1 and status = 'pending' for update",
      [userId],
    );
    const r = rows[0];
    if (!r) return false;
    if (!s.enabled) return false; // stays pending; paid if the programme is switched back on before the next top-up
    const { rows: paid } = await tx.query<{ n: string }>("select coalesce(sum(signed_credits),0)::text as n from wallet_ledger where user_id = $1 and type = 'topup'", [userId]);
    if (Number(paid[0].n) < s.min_topup_npr) return false;
    const { rows: done } = await tx.query<{ n: string }>("select count(*)::text as n from referral_rewards where referrer_id = $1 and status = 'rewarded'", [r.referrer_id]);
    const capped = Number(done[0].n) >= s.max_rewards_per_referrer;
    const referrerCredits = capped ? 0 : s.referrer_credits;
    await tx.query("select wallet_credit_referral($1, $2, $3, 'referrer')", [r.referrer_id, referrerCredits, r.id]);
    await tx.query("select wallet_credit_referral($1, $2, $3, 'referee')", [userId, s.referee_credits, r.id]);
    await tx.query(
      "update referral_rewards set status = $2, referrer_credits = $3, referee_credits = $4, decided_at = now() where id = $1",
      [r.id, capped ? "capped" : "rewarded", referrerCredits, s.referee_credits],
    );
    await tx.query("insert into audit_events (actor_via, action, target_type, target_id, json_detail_redacted) values ('system','referral.rewarded','referral_reward',$1,$2)", [
      r.id, JSON.stringify({ referrer: r.referrer_id, referee: userId, referrerCredits, refereeCredits: s.referee_credits, capped }),
    ]);
    return true;
  });
}

export interface ReferralSummary {
  code: string;
  settings: ReferralSettings;
  invited: number;
  rewarded: number;
  pending: number;
  creditsEarned: number;
}

export async function referralSummary(userId: string, db: Db = getDb()): Promise<ReferralSummary> {
  const [code, settings, stats] = await Promise.all([
    getOrCreateReferralCode(userId, db),
    getSetting("referral", db),
    db.query<{ invited: string; rewarded: string; pending: string; earned: string }>(
      `select count(*)::text as invited,
              count(*) filter (where status = 'rewarded')::text as rewarded,
              count(*) filter (where status = 'pending')::text as pending,
              coalesce(sum(referrer_credits) filter (where status = 'rewarded'),0)::text as earned
         from referral_rewards where referrer_id = $1`,
      [userId],
    ),
  ]);
  const s = stats.rows[0];
  return { code, settings, invited: Number(s.invited), rewarded: Number(s.rewarded), pending: Number(s.pending), creditsEarned: Number(s.earned) };
}

export interface ReferralReport {
  totals: { invited: number; pending: number; rewarded: number; capped: number; creditsPaid: number };
  top: Array<{ userId: string; phone: string; name: string | null; invited: number; rewarded: number; credits: number }>;
}

/** Admin overview of the programme. */
export async function referralReport(db: Db = getDb()): Promise<ReferralReport> {
  const [t, top] = await Promise.all([
    db.query<{ invited: string; pending: string; rewarded: string; capped: string; paid: string }>(
      `select count(*)::text as invited, count(*) filter (where status='pending')::text as pending,
              count(*) filter (where status='rewarded')::text as rewarded, count(*) filter (where status='capped')::text as capped,
              coalesce(sum(referrer_credits + referee_credits) filter (where status in ('rewarded','capped')),0)::text as paid
         from referral_rewards`,
    ),
    db.query<{ id: string; phone_e164: string; display_name: string | null; invited: string; rewarded: string; credits: string }>(
      `select u.id, u.phone_e164, u.display_name, count(*)::text as invited,
              count(*) filter (where r.status = 'rewarded')::text as rewarded, coalesce(sum(r.referrer_credits),0)::text as credits
         from referral_rewards r join users u on u.id = r.referrer_id
        group by u.id order by count(*) desc limit 20`,
    ),
  ]);
  const x = t.rows[0];
  return {
    totals: { invited: Number(x.invited), pending: Number(x.pending), rewarded: Number(x.rewarded), capped: Number(x.capped), creditsPaid: Number(x.paid) },
    top: top.rows.map((r) => ({ userId: r.id, phone: r.phone_e164, name: r.display_name, invited: Number(r.invited), rewarded: Number(r.rewarded), credits: Number(r.credits) })),
  };
}
