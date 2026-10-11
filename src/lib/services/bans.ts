import { getDb, type Db } from "../db";
import { HttpError } from "../core/errors";
import { audit } from "../core/audit";
import { webPrincipal } from "../core/principal";
import { setReminderStatus } from "../core/reminders";
import { revokeAllForUserClient } from "../oauth/tokens";

/**
 * Ban (suspend) a customer. Nothing is deleted: reminders, wallet, ledger,
 * payments and history stay exactly as they are. The account gets status
 * 'suspended', which on its own:
 *  - ends web sessions (session lookup requires an active account),
 *  - blocks sign-in by SMS code, PIN and email (no SMS is sent to a banned number),
 *  - makes ChatGPT / Claude tokens invalid (also revoked here),
 *  - stops message sending (the dispatcher skips inactive accounts).
 * Active reminders are paused and marked ban_paused, so an unban resumes exactly
 * those. A ban can be permanent or last until a date (lifted by the reconciler).
 */
export interface BanInfo {
  banned: boolean;
  bannedAt: string | null;
  bannedBy: string | null;
  reason: string | null;
  until: string | null;
  history: Array<{ action: "ban" | "unban"; reason: string | null; until: string | null; actor: string | null; at: string }>;
}

const who = (id: string) => ({ userId: id, via: "web" as const, scopes: [], locale: "en" });

export async function banInfo(userId: string, db: Db = getDb()): Promise<BanInfo> {
  const { rows } = await db.query<{ status: string; banned_at: string | null; ban_reason: string | null; ban_until: string | null; by: string | null }>(
    `select u.status, u.banned_at, u.ban_reason, u.ban_until, coalesce(a.display_name, a.phone_e164) as by
       from users u left join users a on a.id = u.banned_by where u.id = $1`,
    [userId],
  );
  const { rows: h } = await db.query<{ action: "ban" | "unban"; reason: string | null; until: string | null; actor: string | null; created_at: string }>(
    `select b.action, b.reason, b.until, coalesce(a.display_name, a.phone_e164) as actor, b.created_at
       from user_bans b left join users a on a.id = b.actor_id where b.user_id = $1 order by b.created_at desc limit 20`,
    [userId],
  );
  const r = rows[0];
  const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
  return {
    banned: r?.status === "suspended", bannedAt: iso(r?.banned_at ?? null), bannedBy: r?.by ?? null, reason: r?.ban_reason ?? null, until: iso(r?.ban_until ?? null),
    history: h.map((x) => ({ action: x.action, reason: x.reason, until: iso(x.until), actor: x.actor, at: new Date(x.created_at).toISOString() })),
  };
}

export async function banUser(actor: { id: string }, userId: string, input: { reason: string; until?: string | null }, db: Db = getDb()): Promise<BanInfo> {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 300) throw new HttpError(400, "Write the reason (5–300 characters). It is kept in the account history.", "reason_required");
  if (actor.id === userId) throw new HttpError(400, "You cannot ban your own account.", "self_ban");
  const until = input.until ? new Date(input.until) : null;
  if (until && (Number.isNaN(until.getTime()) || until.getTime() <= Date.now())) throw new HttpError(400, "The ban end must be in the future.", "invalid_until");

  const paused = await db.tx(async (tx) => {
    const { rows } = await tx.query<{ role: string; status: string }>("select role, status from users where id = $1 for update", [userId]);
    const u = rows[0];
    if (!u) throw new HttpError(404, "User not found", "not_found");
    if (u.role !== "user") throw new HttpError(400, "Staff accounts cannot be banned. Change the role to Customer first.", "staff_ban");
    if (u.status === "closed") throw new HttpError(400, "This account is already closed.", "closed");
    await tx.query(
      "update users set status = 'suspended', banned_at = now(), banned_by = $2, ban_reason = $3, ban_until = $4, updated_at = now() where id = $1",
      [userId, actor.id, reason, until?.toISOString() ?? null],
    );
    await tx.query("insert into user_bans (user_id, action, reason, until, actor_id) values ($1, 'ban', $2, $3, $4)", [userId, reason, until?.toISOString() ?? null, actor.id]);
    // Mark first, pause after the commit (each pause releases that reminder's held credits).
    const { rows: act } = await tx.query<{ id: string }>("update renewal_items set ban_paused = true where owner_user_id = $1 and status = 'active' returning id", [userId]);
    await audit(tx, who(actor.id), "user.banned", { type: "user", id: userId }, { reason, until: until?.toISOString() ?? null, reminders: act.length });
    return act.map((r) => r.id);
  });
  const owner = webPrincipal({ id: userId, locale: "en" });
  for (const id of paused) {
    await setReminderStatus(owner, id, "pause", {}, db).catch((e) => console.warn(`[ban] pause ${id}: ${(e as Error).message}`));
  }
  await revokeAllForUserClient(userId, null, "account_suspended", db);
  return banInfo(userId, db);
}

export async function unbanUser(actor: { id: string } | null, userId: string, note: string | null, db: Db = getDb()): Promise<BanInfo & { resumed: number; notResumed: number }> {
  const ids = await db.tx(async (tx) => {
    const { rows } = await tx.query<{ status: string }>("select status from users where id = $1 for update", [userId]);
    if (!rows[0]) throw new HttpError(404, "User not found", "not_found");
    if (rows[0].status !== "suspended") throw new HttpError(409, "This account is not banned.", "not_banned");
    await tx.query("update users set status = 'active', banned_at = null, banned_by = null, ban_reason = null, ban_until = null, updated_at = now() where id = $1", [userId]);
    await tx.query("insert into user_bans (user_id, action, reason, actor_id) values ($1, 'unban', $2, $3)", [userId, note?.trim() || (actor ? null : "Ban period ended"), actor?.id ?? null]);
    const { rows: r } = await tx.query<{ id: string }>("update renewal_items set ban_paused = false where owner_user_id = $1 and ban_paused returning id, status", [userId]);
    await audit(tx, actor ? who(actor.id) : null, "user.unbanned", { type: "user", id: userId }, { note, automatic: !actor });
    return r.map((x) => x.id);
  });
  const owner = webPrincipal({ id: userId, locale: "en" });
  let resumed = 0;
  let notResumed = 0;
  for (const id of ids) {
    const { rows } = await db.query<{ status: string }>("select status from renewal_items where id = $1", [id]);
    if (rows[0]?.status !== "paused") continue; // the customer had changed it since
    try {
      await setReminderStatus(owner, id, "resume", {}, db);
      resumed++;
    } catch {
      notResumed++; // e.g. not enough credits: it stays paused and the customer can resume it
    }
  }
  return { ...(await banInfo(userId, db)), resumed, notResumed };
}

/** Reconciler: lift time-limited bans that have ended. */
export async function liftExpiredBans(db: Db = getDb(), now: Date = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: string }>("select id from users where status = 'suspended' and ban_until is not null and ban_until <= $1 limit 50", [now.toISOString()]);
  let n = 0;
  for (const r of rows) {
    await unbanUser(null, r.id, null, db).then(() => n++).catch((e) => console.warn(`[ban] auto-lift ${r.id}: ${(e as Error).message}`));
  }
  return n;
}
