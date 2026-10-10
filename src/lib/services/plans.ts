import { getDb, type Db } from "../db";
import { HttpError } from "../core/errors";
import { audit } from "../core/audit";
import { readWallet } from "../core/wallet";
import { getSetting, type ProSettings } from "./settings";

/**
 * Nabikaran Pro.
 *  - trial  (once per account): Pro features for N days, no included messages
 *  - paid   bought with wallet credits; Pro features + included messages
 *  - grant  given by a super admin; same as paid
 * Purchases are final (no refunds). Basic accounts never see Pro features;
 * every Pro API checks `requirePro` on the server.
 */
export type PlanKind = "trial" | "paid" | "grant";
export type PlanChannel = "sms" | "whatsapp" | "email";
export const PLAN_CHANNELS: PlanChannel[] = ["sms", "whatsapp", "email"];

export interface AllowanceView {
  channel: PlanChannel;
  granted: number;
  reserved: number;
  used: number;
  left: number;
}

export interface PlanState {
  tier: "basic" | "pro";
  kind: PlanKind | null;
  planId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  daysLeft: number;
  trialUsed: boolean;
  /** A paid/grant plan that starts when the current one ends. */
  queuedUntil: string | null;
  allowances: AllowanceView[];
  offer: ProSettings;
}

interface PlanRow {
  id: string;
  kind: PlanKind;
  starts_at: string;
  ends_at: string;
}

const DAY = 86_400_000;

async function activePlans(userId: string, db: Db, at: Date = new Date()): Promise<PlanRow[]> {
  const { rows } = await db.query<PlanRow>(
    `select id, kind, starts_at, ends_at from user_plans
      where user_id = $1 and status = 'active' and ends_at > $2 order by starts_at`,
    [userId, at.toISOString()],
  );
  return rows;
}

export async function getPlanState(userId: string, db: Db = getDb(), now: Date = new Date()): Promise<PlanState> {
  const [offer, plans, trial] = await Promise.all([
    getSetting("pro", db),
    activePlans(userId, db, now),
    db.query("select 1 from user_plans where user_id = $1 and kind = 'trial'", [userId]),
  ]);
  const started = plans.filter((p) => new Date(p.starts_at).getTime() <= now.getTime());
  const current = started.find((p) => p.kind !== "trial") ?? started[0] ?? null;
  const later = plans.filter((p) => p.kind !== "trial" && new Date(p.starts_at).getTime() > now.getTime());
  let allowances: AllowanceView[] = [];
  if (current && current.kind !== "trial") {
    const { rows } = await db.query<{ channel: PlanChannel; granted: number; reserved: number; used: number }>(
      "select channel, granted, reserved, used from plan_allowances where user_plan_id = $1",
      [current.id],
    );
    allowances = PLAN_CHANNELS.map((ch) => {
      const r = rows.find((x) => x.channel === ch) ?? { granted: 0, reserved: 0, used: 0 };
      return { channel: ch, granted: r.granted, reserved: r.reserved, used: r.used, left: Math.max(0, r.granted - r.reserved - r.used) };
    });
  }
  return {
    tier: current ? "pro" : "basic",
    kind: current?.kind ?? null,
    planId: current?.id ?? null,
    startsAt: current ? new Date(current.starts_at).toISOString() : null,
    endsAt: current ? new Date(current.ends_at).toISOString() : null,
    daysLeft: current ? Math.max(0, Math.ceil((new Date(current.ends_at).getTime() - now.getTime()) / DAY)) : 0,
    trialUsed: Boolean(trial.rows[0]),
    queuedUntil: later.length ? new Date(later[later.length - 1].ends_at).toISOString() : null,
    allowances,
    offer,
  };
}

export async function isPro(userId: string, db: Db = getDb(), now: Date = new Date()): Promise<boolean> {
  const { rows } = await db.query(
    "select 1 from user_plans where user_id = $1 and status = 'active' and starts_at <= $2 and ends_at > $2 limit 1",
    [userId, now.toISOString()],
  );
  return Boolean(rows[0]);
}

/** Server-side gate for every Pro feature. */
export async function requirePro(userId: string, db: Db = getDb()): Promise<void> {
  if (!(await isPro(userId, db))) throw new HttpError(403, "This is a Nabikaran Pro feature.", "pro_required");
}

const who = (userId: string) => ({ userId, via: "web" as const, scopes: [], locale: "en" });

export async function startTrial(userId: string, db: Db = getDb(), now: Date = new Date()): Promise<PlanState> {
  const offer = await getSetting("pro", db);
  if (!offer.enabled || !offer.trial_enabled) throw new HttpError(400, "The free trial is not available right now.", "trial_unavailable");
  await db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('plan:' || $1))", [userId]);
    if (await isPro(userId, tx, now)) throw new HttpError(409, "You already have Pro.", "already_pro");
    const { rows: used } = await tx.query("select 1 from user_plans where user_id = $1 and kind = 'trial'", [userId]);
    if (used[0]) throw new HttpError(409, "The free trial can be used once per account.", "trial_used");
    const { rows } = await tx.query<{ id: string }>(
      "insert into user_plans (user_id, kind, starts_at, ends_at) values ($1, 'trial', $2, $3) returning id",
      [userId, now.toISOString(), new Date(now.getTime() + offer.trial_days * DAY).toISOString()],
    );
    await audit(tx, who(userId), "plan.trial_started", { type: "user_plan", id: rows[0].id }, { days: offer.trial_days });
  });
  return getPlanState(userId, db, now);
}

/**
 * Re-fund this user's scheduled messages so ones due within a paid plan use
 * its included messages; the credits they held go back to the wallet.
 */
async function refundIntoAllowance(tx: Db, userId: string): Promise<number> {
  const { rows } = await tx.query<{ id: string }>(
    `select j.id from reminder_jobs j join credit_reservations r on r.reminder_job_id = j.id
      where j.user_id = $1 and j.status = 'scheduled' and r.status = 'active' and r.allowance_units = 0
      order by j.due_at_utc`,
    [userId],
  );
  let moved = 0;
  for (const j of rows) {
    await tx.query("select wallet_release_for_job($1)", [j.id]);
    await tx.query("select wallet_reserve_for_job($1)", [j.id]);
    const { rows: r } = await tx.query<{ n: number }>("select allowance_units as n from credit_reservations where reminder_job_id = $1", [j.id]);
    if ((r[0]?.n ?? 0) > 0) moved++;
  }
  // Messages that were waiting for credits may now be covered.
  const { rows: waiting } = await tx.query<{ id: string }>("select id from reminder_jobs where user_id = $1 and status = 'awaiting_credits' order by due_at_utc", [userId]);
  for (const j of waiting) await tx.query("select wallet_reserve_for_job($1)", [j.id]);
  return moved;
}

async function insertPaidPlan(tx: Db, userId: string, kind: "paid" | "grant", start: Date, days: number, price: number, allowances: Record<PlanChannel, number>, by: string | null, note: string | null): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    "insert into user_plans (user_id, kind, starts_at, ends_at, price_credits, created_by, note) values ($1,$2,$3,$4,$5,$6,$7) returning id",
    [userId, kind, start.toISOString(), new Date(start.getTime() + days * DAY).toISOString(), price, by, note],
  );
  for (const ch of PLAN_CHANNELS) {
    await tx.query("insert into plan_allowances (user_plan_id, channel, granted) values ($1,$2,$3)", [rows[0].id, ch, allowances[ch]]);
  }
  return rows[0].id;
}

/** When a new paid/grant plan should start: now, or when the current paid/grant plan ends. A trial ends now. */
async function nextStart(tx: Db, userId: string, now: Date): Promise<Date> {
  await tx.query(
    "update user_plans set starts_at = least(starts_at, $2::timestamptz - interval '1 second'), ends_at = $2 where user_id = $1 and kind = 'trial' and status = 'active' and ends_at > $2",
    [userId, now.toISOString()],
  );
  const { rows } = await tx.query<{ e: string | null }>(
    "select max(ends_at) as e from user_plans where user_id = $1 and status = 'active' and kind in ('paid','grant') and ends_at > $2",
    [userId, now.toISOString()],
  );
  return rows[0]?.e ? new Date(rows[0].e) : now;
}

const allowancesFrom = (o: ProSettings): Record<PlanChannel, number> => ({ sms: o.allowance_sms, whatsapp: o.allowance_whatsapp, email: o.allowance_email });

export interface BuyResult {
  state: PlanState;
  planId: string;
  replayed: boolean;
}

/**
 * Buy Pro with wallet credits (1 credit = NPR 1). Final: no refunds.
 * Buying while Pro is active adds a new year after the current one.
 */
export async function buyPro(userId: string, idempotencyKey: string, db: Db = getDb(), now: Date = new Date()): Promise<BuyResult> {
  const offer = await getSetting("pro", db);
  if (!offer.enabled) throw new HttpError(400, "Pro is not available right now.", "pro_unavailable");
  const result = await db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('plan:' || $1))", [userId]);
    // Same click twice (double tap, retry): return the first purchase.
    const { rows: prior } = await tx.query<{ id: string }>(
      "select id from user_plans where user_id = $1 and kind = 'paid' and note = $2",
      [userId, `key:${idempotencyKey}`],
    );
    if (prior[0]) return { planId: prior[0].id, replayed: true };
    const w = await readWallet(userId, tx);
    if (w.available < offer.price_npr) {
      const shortfall = offer.price_npr - w.available;
      throw new HttpError(402, `Pro costs ${offer.price_npr} credits and you have ${w.available}. Top up ${shortfall} credits.`, "insufficient_credits", {
        neededCredits: offer.price_npr, availableCredits: w.available, shortfallCredits: shortfall,
      });
    }
    const start = await nextStart(tx, userId, now);
    const planId = await insertPaidPlan(tx, userId, "paid", start, offer.duration_days, offer.price_npr, allowancesFrom(offer), userId, `key:${idempotencyKey}`);
    await tx.query("select wallet_buy_plan($1, $2, $3)", [userId, offer.price_npr, planId]);
    const moved = start.getTime() <= now.getTime() ? await refundIntoAllowance(tx, userId) : 0;
    await audit(tx, who(userId), "plan.purchased", { type: "user_plan", id: planId }, { credits: offer.price_npr, starts: start.toISOString(), days: offer.duration_days, movedToAllowance: moved });
    return { planId, replayed: false };
  });
  return { ...result, state: await getPlanState(userId, db, now) };
}

/** Super admin: give Pro for N days (with or without included messages). */
export async function grantPro(admin: { id: string }, userId: string, opts: { days: number; withAllowances: boolean; note: string }, db: Db = getDb(), now: Date = new Date()): Promise<PlanState> {
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 730) throw new HttpError(400, "Days must be 1–730", "invalid_days");
  const offer = await getSetting("pro", db);
  await db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('plan:' || $1))", [userId]);
    const { rows: u } = await tx.query("select 1 from users where id = $1", [userId]);
    if (!u[0]) throw new HttpError(404, "User not found", "not_found");
    const start = await nextStart(tx, userId, now);
    const allowances = opts.withAllowances ? allowancesFrom(offer) : { sms: 0, whatsapp: 0, email: 0 };
    const planId = await insertPaidPlan(tx, userId, "grant", start, opts.days, 0, allowances, admin.id, opts.note.slice(0, 200) || null);
    if (start.getTime() <= now.getTime()) await refundIntoAllowance(tx, userId);
    await audit(tx, who(admin.id), "plan.granted", { type: "user", id: userId }, { planId, days: opts.days, withAllowances: opts.withAllowances, note: opts.note });
  });
  return getPlanState(userId, db, now);
}

/** Super admin: end a plan now. Messages it was funding go back to credits (or wait for credits). */
export async function revokePlan(admin: { id: string }, planId: string, reason: string, db: Db = getDb()): Promise<void> {
  await db.tx(async (tx) => {
    const { rows } = await tx.query<{ user_id: string }>("update user_plans set status = 'revoked' where id = $1 and status = 'active' returning user_id", [planId]);
    if (!rows[0]) throw new HttpError(404, "Active plan not found", "not_found");
    const { rows: jobs } = await tx.query<{ id: string }>(
      `select j.id from reminder_jobs j join credit_reservations r on r.reminder_job_id = j.id
        where r.allowance_plan_id = $1 and r.status = 'active' and j.status = 'scheduled' order by j.due_at_utc`,
      [planId],
    );
    for (const j of jobs) {
      await tx.query("select wallet_release_for_job($1)", [j.id]);
      await tx.query("select wallet_reserve_for_job($1)", [j.id]);
    }
    await audit(tx, who(admin.id), "plan.revoked", { type: "user_plan", id: planId }, { userId: rows[0].user_id, reason, refunded: false, jobs: jobs.length });
  });
}

export interface PlanHistoryRow {
  id: string;
  kind: PlanKind;
  status: string;
  startsAt: string;
  endsAt: string;
  priceCredits: number;
  note: string | null;
}

export async function planHistory(userId: string, db: Db = getDb()): Promise<PlanHistoryRow[]> {
  const { rows } = await db.query<{ id: string; kind: PlanKind; status: string; starts_at: string; ends_at: string; price_credits: string; note: string | null }>(
    "select id, kind, status, starts_at, ends_at, price_credits::text, note from user_plans where user_id = $1 order by starts_at desc limit 20",
    [userId],
  );
  return rows.map((r) => ({
    id: r.id, kind: r.kind, status: r.status, startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(),
    priceCredits: Number(r.price_credits), note: r.note?.startsWith("key:") ? null : r.note,
  }));
}

export interface ProReport {
  activePaid: number;
  activeTrial: number;
  activeGrant: number;
  trialsStarted: number;
  trialToPaid: number;
  revenueCredits: number;
  recent: Array<{ userId: string; phone: string; name: string | null; kind: PlanKind; endsAt: string }>;
}

export async function proReport(db: Db = getDb()): Promise<ProReport> {
  const { rows: c } = await db.query<{ paid: number; trial: number; grant: number; trials: number; converted: number; revenue: string }>(
    `select
       count(*) filter (where kind = 'paid' and status = 'active' and starts_at <= now() and ends_at > now())::int as paid,
       count(*) filter (where kind = 'trial' and status = 'active' and starts_at <= now() and ends_at > now())::int as trial,
       count(*) filter (where kind = 'grant' and status = 'active' and starts_at <= now() and ends_at > now())::int as grant,
       count(*) filter (where kind = 'trial')::int as trials,
       (select count(distinct t.user_id) from user_plans t where t.kind = 'trial' and exists (select 1 from user_plans p where p.user_id = t.user_id and p.kind = 'paid'))::int as converted,
       coalesce(sum(price_credits) filter (where kind = 'paid'), 0)::text as revenue
     from user_plans`,
  );
  const { rows: recent } = await db.query<{ user_id: string; phone_e164: string; display_name: string | null; kind: PlanKind; ends_at: string }>(
    `select p.user_id, u.phone_e164, u.display_name, p.kind, p.ends_at from user_plans p join users u on u.id = p.user_id
      where p.status = 'active' and p.ends_at > now() order by p.created_at desc limit 30`,
  );
  return {
    activePaid: c[0].paid, activeTrial: c[0].trial, activeGrant: c[0].grant, trialsStarted: c[0].trials, trialToPaid: c[0].converted, revenueCredits: Number(c[0].revenue),
    recent: recent.map((r) => ({ userId: r.user_id, phone: r.phone_e164, name: r.display_name, kind: r.kind, endsAt: new Date(r.ends_at).toISOString() })),
  };
}
