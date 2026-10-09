import { getDb, type Db } from "../db";
import { HttpError } from "../core/errors";
import { sumEvents } from "../core/rate-limit";

export interface Metrics {
  users: { total: number; verified: number; last7d: number };
  wallet: { postedLiabilityCredits: number; reservedCredits: number; topupsPaid: number; topupRevenuePaisa: number };
  jobs: Record<string, number>;
  sms: { attempts24h: number; accepted24h: number; unknownOpen: number };
  payments: { pendingOrders: number; mismatches: number };
  worker: { lastDispatchAt: string | null; minutesSinceDispatch: number | null };
  mcp: { clients: number; disabledClients: number; connectedUsers: number; toolCalls24h: number; toolErrors24h: number; unauthorized24h: number; prepared24h: number; confirmed24h: number };
}

export async function getMetrics(db: Db = getDb()): Promise<Metrics> {
  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0] as T;
  const users = await one<{ total: string; verified: string; last7d: string }>(
    "select count(*)::text as total, count(phone_verified_at)::text as verified, count(*) filter (where created_at > now() - interval '7 days')::text as last7d from users",
  );
  const wallet = await one<{ posted: string; reserved: string }>("select coalesce(sum(posted_balance_credits),0)::text as posted, coalesce(sum(reserved_credits),0)::text as reserved from wallets");
  const topups = await one<{ n: string; paisa: string }>("select count(*)::text as n, coalesce(sum(amount_paisa),0)::text as paisa from payment_orders where status = 'paid'");
  const { rows: jobRows } = await db.query<{ status: string; n: string }>("select status, count(*)::text as n from reminder_jobs group by status");
  const sms = await one<{ attempts: string; accepted: string; unknown_open: string }>(
    `select count(*) filter (where request_at > now() - interval '24 hours')::text as attempts,
            count(*) filter (where request_at > now() - interval '24 hours' and api_state = 'accepted')::text as accepted,
            count(*) filter (where api_state in ('unknown','pending'))::text as unknown_open from sms_attempts`,
  );
  const pay = await one<{ pending: string; mismatches: string }>(
    `select (select count(*) from payment_orders where status in ('initiated','pending'))::text as pending,
            (select count(*) from audit_events where action = 'payment.amount_mismatch')::text as mismatches`,
  );
  const mcp = await one<{ clients: string; disabled: string; users: string; prepared: string; confirmed: string }>(
    `select (select count(*) from oauth_clients)::text as clients,
            (select count(*) from oauth_clients where disabled_at is not null)::text as disabled,
            (select count(distinct user_id) from oauth_tokens where kind = 'refresh' and revoked_at is null and expires_at > now())::text as users,
            (select count(*) from audit_events where action = 'reminder.prepare' and created_at > now() - interval '24 hours')::text as prepared,
            (select count(*) from audit_events where action = 'reminder.confirm' and created_at > now() - interval '24 hours')::text as confirmed`,
  );
  const [toolOk, toolErr, un401] = await Promise.all([sumEvents(db, "mcp:tool_ok"), sumEvents(db, "mcp:tool_error"), (async () => {
    const { rows } = await db.query<{ n: string }>("select coalesce(sum(n),0)::text as n from request_counters where subject = 'metrics' and bucket like 'mcp:401:%' and window_start > now() - interval '24 hours'");
    return Number(rows[0]?.n ?? 0);
  })()]);
  const hb = await one<{ at: string | null }>("select max(created_at)::text as at from audit_events where action = 'worker.heartbeat' and target_id = 'dispatch'");
  const lastDispatchAt = hb?.at ? new Date(hb.at).toISOString() : null;
  return {
    users: { total: Number(users.total), verified: Number(users.verified), last7d: Number(users.last7d) },
    wallet: { postedLiabilityCredits: Number(wallet.posted), reservedCredits: Number(wallet.reserved), topupsPaid: Number(topups.n), topupRevenuePaisa: Number(topups.paisa) },
    jobs: Object.fromEntries(jobRows.map((r) => [r.status, Number(r.n)])),
    sms: { attempts24h: Number(sms.attempts), accepted24h: Number(sms.accepted), unknownOpen: Number(sms.unknown_open) },
    payments: { pendingOrders: Number(pay.pending), mismatches: Number(pay.mismatches) },
    worker: { lastDispatchAt, minutesSinceDispatch: lastDispatchAt ? Math.round((Date.now() - new Date(lastDispatchAt).getTime()) / 60_000) : null },
    mcp: { clients: Number(mcp.clients), disabledClients: Number(mcp.disabled), connectedUsers: Number(mcp.users), toolCalls24h: toolOk + toolErr, toolErrors24h: toolErr, unauthorized24h: un401, prepared24h: Number(mcp.prepared), confirmed24h: Number(mcp.confirmed) },
  };
}

/** Prospective price change: inserted with a future effective_at; existing reservations keep their cost snapshot. */
export async function createPricingVersion(actorId: string, creditsPerUnit: number, effectiveAt: Date, db: Db = getDb()) {
  if (!Number.isInteger(creditsPerUnit) || creditsPerUnit <= 0) throw new HttpError(400, "creditsPerUnit must be a positive integer");
  if (effectiveAt.getTime() < Date.now() - 60_000) throw new HttpError(400, "Price changes are prospective only");
  const { rows } = await db.query<{ id: number }>(
    "insert into pricing_versions (credits_per_billable_unit, effective_at, created_by) values ($1,$2,$3) returning id",
    [creditsPerUnit, effectiveAt.toISOString(), actorId],
  );
  await db.query("insert into audit_events (actor_user_id, action, target_type, target_id, json_detail_redacted) values ($1,'pricing.create','pricing_version',$2,$3)", [
    actorId, String(rows[0].id), JSON.stringify({ creditsPerUnit, effectiveAt }),
  ]);
  return rows[0].id;
}

export async function requestWalletAdjustment(actorId: string, userId: string, signedCredits: number, reason: string, db: Db = getDb()) {
  if (!Number.isInteger(signedCredits) || signedCredits === 0) throw new HttpError(400, "signedCredits must be a non-zero integer");
  if (!reason.trim()) throw new HttpError(400, "reason required");
  const { rows } = await db.query<{ id: string }>(
    "insert into wallet_adjustment_requests (user_id, signed_credits, reason, requested_by) values ($1,$2,$3,$4) returning id",
    [userId, signedCredits, reason.trim(), actorId],
  );
  await db.query("insert into audit_events (actor_user_id, action, target_type, target_id, json_detail_redacted) values ($1,'wallet.adjustment_requested','wallet_adjustment_request',$2,$3)", [
    actorId, rows[0].id, JSON.stringify({ userId, signedCredits, reason }),
  ]);
  return rows[0].id;
}

/** Second admin approves and applies in one transaction (two-person rule enforced in SQL too). */
export async function approveWalletAdjustment(actorId: string, requestId: string, db: Db = getDb()) {
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ requested_by: string; status: string; user_id: string }>("select requested_by, status, user_id from wallet_adjustment_requests where id = $1 for update", [requestId]);
    if (!rows[0]) throw new HttpError(404, "Request not found");
    if (rows[0].user_id === actorId) throw new HttpError(403, "You cannot approve an adjustment to your own wallet", "self_adjustment");
    if (rows[0].status !== "pending") throw new HttpError(409, "Request already decided");
    if (rows[0].requested_by === actorId) throw new HttpError(403, "A different admin must approve", "two_person_rule");
    await tx.query("update wallet_adjustment_requests set status = 'approved', approved_by = $2, decided_at = now() where id = $1", [requestId, actorId]);
    await tx.query("select wallet_apply_adjustment($1)", [requestId]);
    await tx.query("insert into audit_events (actor_user_id, action, target_type, target_id) values ($1,'wallet.adjustment_applied','wallet_adjustment_request',$2)", [actorId, requestId]);
    return true;
  });
}
