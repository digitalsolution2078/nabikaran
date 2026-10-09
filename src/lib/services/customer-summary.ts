import { getDb, type Db } from "../db";
import { readWallet, type WalletView } from "../core/wallet";

/**
 * Customer dashboard data in a handful of indexed queries. Every timestamp is
 * returned as an ISO string (node-postgres returns Date objects, which must
 * never reach string-only code paths).
 */
export interface MessageRow {
  id: string;
  renewalId: string;
  label: string;
  category: string;
  channel: "sms" | "whatsapp";
  status: string;
  dueAt: string;
  offsetMinutes: number;
  credits: number;
  lastError: string | null;
}

export interface CustomerSummary {
  counts: { active: number; paused: number; expired: number; dueSoon: number; upcomingMessages: number; awaitingCredits: number };
  wallet: WalletView;
  next: MessageRow | null;
  expiringSoon: Array<{ id: string; label: string; category: string; expiryAt: string; channels: string[] }>;
  upcoming: MessageRow[];
  recent: MessageRow[];
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

interface RawMsg {
  id: string; renewal_id: string; label: string; category: string; channel: string; status: string;
  due_at_utc: unknown; offset_minutes: number | null; estimated_credits: string | number; last_error: string | null;
}
function toMsg(r: RawMsg): MessageRow {
  return {
    id: r.id, renewalId: r.renewal_id, label: r.label, category: r.category,
    channel: r.channel === "whatsapp" ? "whatsapp" : "sms", status: r.status, dueAt: iso(r.due_at_utc),
    offsetMinutes: Number(r.offset_minutes ?? 0), credits: Number(r.estimated_credits), lastError: r.last_error,
  };
}

const MSG_SELECT = `select j.id, j.renewal_id, i.label, i.category, j.channel, j.status, j.due_at_utc, r.offset_minutes, j.estimated_credits, j.last_error
  from reminder_jobs j join renewal_items i on i.id = j.renewal_id left join reminder_rules r on r.id = j.rule_id`;

export async function getCustomerSummary(userId: string, db: Db = getDb(), dueSoonDays = 30): Promise<CustomerSummary> {
  const [counts, wallet, upcoming, recent, expiring] = await Promise.all([
    db.query<Record<string, string>>(
      `select
         (select count(*) from renewal_items where owner_user_id = $1 and status = 'active')::text as active,
         (select count(*) from renewal_items where owner_user_id = $1 and status = 'paused')::text as paused,
         (select count(*) from renewal_items where owner_user_id = $1 and status = 'active' and expiry_at_utc < now())::text as expired,
         (select count(*) from renewal_items where owner_user_id = $1 and status = 'active' and expiry_at_utc >= now() and expiry_at_utc < now() + make_interval(days => $2))::text as due_soon,
         (select count(*) from reminder_jobs j join renewal_items i on i.id = j.renewal_id
            where j.user_id = $1 and j.status in ('scheduled','planned') and j.cycle_no = i.cycle_no and i.status = 'active')::text as upcoming,
         (select count(*) from reminder_jobs j join renewal_items i on i.id = j.renewal_id
            where j.user_id = $1 and j.status = 'awaiting_credits' and j.cycle_no = i.cycle_no and i.status = 'active')::text as awaiting`,
      [userId, dueSoonDays],
    ),
    readWallet(userId, db),
    db.query<RawMsg>(
      `${MSG_SELECT} where j.user_id = $1 and j.status in ('scheduled','planned','awaiting_credits','sending','unknown') and j.cycle_no = i.cycle_no and i.status = 'active'
        order by j.due_at_utc asc limit 8`,
      [userId],
    ),
    db.query<RawMsg>(`${MSG_SELECT} where j.user_id = $1 and j.status in ('submitted','delivered','read','failed') order by j.updated_at desc limit 6`, [userId]),
    db.query<{ id: string; label: string; category: string; expiry_at_utc: unknown; channels: string[] | null }>(
      `select id, label, category, expiry_at_utc, channels from renewal_items
        where owner_user_id = $1 and status = 'active' order by expiry_at_utc asc limit 6`,
      [userId],
    ),
  ]);
  const c = counts.rows[0] ?? {};
  const up = upcoming.rows.map(toMsg);
  return {
    counts: {
      active: Number(c.active ?? 0), paused: Number(c.paused ?? 0), expired: Number(c.expired ?? 0), dueSoon: Number(c.due_soon ?? 0),
      upcomingMessages: Number(c.upcoming ?? 0), awaitingCredits: Number(c.awaiting ?? 0),
    },
    wallet,
    next: up.find((m) => m.status === "scheduled" || m.status === "planned") ?? null,
    expiringSoon: expiring.rows.map((r) => ({ id: r.id, label: r.label, category: r.category, expiryAt: iso(r.expiry_at_utc), channels: r.channels ?? ["sms"] })),
    upcoming: up,
    recent: recent.rows.map(toMsg),
  };
}

/** All messages for the customer's Messages page (pending first, then history). */
export async function listCustomerMessages(userId: string, kind: "pending" | "history", db: Db = getDb(), limit = 100): Promise<MessageRow[]> {
  const { rows } =
    kind === "pending"
      ? await db.query<RawMsg>(
          `${MSG_SELECT} where j.user_id = $1 and j.status in ('scheduled','planned','awaiting_credits','sending','unknown') and j.cycle_no = i.cycle_no and i.status = 'active'
            order by j.due_at_utc asc limit $2`,
          [userId, limit],
        )
      : await db.query<RawMsg>(`${MSG_SELECT} where j.user_id = $1 and j.status in ('submitted','delivered','read','failed') order by j.updated_at desc limit $2`, [userId, limit]);
  return rows.map(toMsg);
}

export type RenewalFilter = "active" | "paused" | "awaiting" | "expired" | "due" | "all";

export interface RenewalListRow {
  id: string;
  label: string;
  category: string;
  familyMemberLabel: string | null;
  status: "active" | "paused" | "cancelled";
  expiryAt: string;
  channels: Array<"sms" | "whatsapp">;
  nextAt: string | null;
  nextChannel: "sms" | "whatsapp" | null;
  pendingMessages: number;
  awaitingMessages: number;
  heldCredits: number;
  expired: boolean;
}

/** Customer renewals list with filters and search (label, family member, notes). */
export async function listRenewalsForUser(userId: string, opts: { filter?: RenewalFilter; q?: string; limit?: number } = {}, db: Db = getDb()): Promise<RenewalListRow[]> {
  const filter = opts.filter ?? "active";
  const where: string[] = ["i.owner_user_id = $1", "i.status <> 'deleted'"];
  const params: unknown[] = [userId];
  if (filter === "active") where.push("i.status = 'active' and i.expiry_at_utc >= now()");
  if (filter === "paused") where.push("i.status = 'paused'");
  if (filter === "expired") where.push("i.status = 'active' and i.expiry_at_utc < now()");
  if (filter === "due") where.push("i.status = 'active' and i.expiry_at_utc >= now() and i.expiry_at_utc < now() + interval '30 days'");
  if (filter === "awaiting") where.push("exists (select 1 from reminder_jobs a where a.renewal_id = i.id and a.cycle_no = i.cycle_no and a.status = 'awaiting_credits')");
  if (filter === "all") where.push("i.status in ('active','paused','cancelled')");
  const q = (opts.q ?? "").trim().slice(0, 60);
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    where.push(`(i.label ilike $${params.length} or coalesce(i.family_member_label,'') ilike $${params.length} or coalesce(i.notes,'') ilike $${params.length})`);
  }
  params.push(Math.min(opts.limit ?? 200, 500));
  const { rows } = await db.query<{
    id: string; label: string; category: string; family_member_label: string | null; status: RenewalListRow["status"]; expiry_at_utc: unknown;
    channels: string[] | null; next_at: unknown; next_channel: string | null; pending: string; awaiting: string; held: string;
  }>(
    `select i.id, i.label, i.category, i.family_member_label, i.status, i.expiry_at_utc, i.channels,
            n.due_at_utc as next_at, n.channel as next_channel,
            (select count(*) from reminder_jobs j where j.renewal_id = i.id and j.cycle_no = i.cycle_no and j.status in ('scheduled','planned','awaiting_credits'))::text as pending,
            (select count(*) from reminder_jobs j where j.renewal_id = i.id and j.cycle_no = i.cycle_no and j.status = 'awaiting_credits')::text as awaiting,
            (select coalesce(sum(r.held_credits),0) from credit_reservations r join reminder_jobs j on j.id = r.reminder_job_id
              where j.renewal_id = i.id and r.status = 'active')::text as held
       from renewal_items i
       left join lateral (
         select j.due_at_utc, j.channel from reminder_jobs j
          where j.renewal_id = i.id and j.cycle_no = i.cycle_no and j.status in ('scheduled','planned') and j.due_at_utc > now()
          order by j.due_at_utc asc limit 1
       ) n on true
      where ${where.join(" and ")}
      order by (i.status = 'active') desc, i.expiry_at_utc asc
      limit $${params.length}`,
    params,
  );
  const now = Date.now();
  return rows.map((r) => {
    const expiryAt = iso(r.expiry_at_utc);
    return {
      id: r.id, label: r.label, category: r.category, familyMemberLabel: r.family_member_label, status: r.status, expiryAt,
      channels: (r.channels ?? ["sms"]).filter((c): c is "sms" | "whatsapp" => c === "sms" || c === "whatsapp"),
      nextAt: r.next_at ? iso(r.next_at) : null, nextChannel: r.next_channel === "whatsapp" ? "whatsapp" : r.next_channel ? "sms" : null,
      pendingMessages: Number(r.pending), awaitingMessages: Number(r.awaiting), heldCredits: Number(r.held),
      expired: new Date(expiryAt).getTime() < now,
    };
  });
}

/** Sent history of one renewal across all cycles (owner-checked). */
export async function listRenewalHistory(userId: string, renewalId: string, db: Db = getDb()): Promise<MessageRow[]> {
  const { rows } = await db.query<RawMsg>(
    `${MSG_SELECT} where j.user_id = $1 and j.renewal_id = $2 and j.status in ('submitted','delivered','read','failed') order by j.due_at_utc desc limit 100`,
    [userId, renewalId],
  );
  return rows.map(toMsg);
}
