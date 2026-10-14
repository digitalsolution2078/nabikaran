import { getDb, type Db } from "../db";
import { HttpError } from "../core/errors";
import { isPro } from "./plans";
import { getSetting } from "./settings";

/**
 * Record limits: how many records (reminders, documents, subscriptions, with
 * or without reminders) an account keeps. Free 150, Pro 10,000 by default
 * (Admin → Settings). Active and paused records count; deleted ones and the
 * automatic "cancel by" companions of subscriptions do not. Nothing is ever
 * removed when an account is over its limit: only adding new records stops.
 */
export interface RecordUsage {
  used: number;
  limit: number;
  pro: boolean;
  /** Free limit (shown to Basic accounts as what Pro raises). */
  freeLimit: number;
  proLimit: number;
}

export async function recordUsage(userId: string, db: Db = getDb()): Promise<RecordUsage> {
  const [s, pro, { rows }] = await Promise.all([
    getSetting("limits", db),
    isPro(userId, db),
    db.query<{ n: number }>("select count(*)::int as n from renewal_items where owner_user_id = $1 and status in ('active','paused') and linked_to is null", [userId]),
  ]);
  return { used: rows[0].n, limit: pro ? s.pro_records : s.free_records, pro, freeLimit: s.free_records, proLimit: s.pro_records };
}

/** Admin: Free accounts at or near their record limit (people to offer Pro). */
export async function limitStats(db: Db = getDb()): Promise<{ overFree: number; nearFree: number }> {
  const s = await getSetting("limits", db);
  const { rows } = await db.query<{ over: number; near: number }>(
    `with c as (
       select i.owner_user_id, count(*) as n from renewal_items i
        where i.status in ('active','paused') and i.linked_to is null
          and not exists (select 1 from user_plans p where p.user_id = i.owner_user_id and p.status = 'active' and p.starts_at <= now() and p.ends_at > now())
        group by 1)
     select count(*) filter (where n >= $1)::int as over, count(*) filter (where n < $1 and n >= $1 - 20)::int as near from c`,
    [s.free_records],
  );
  return { overFree: rows[0]?.over ?? 0, nearFree: rows[0]?.near ?? 0 };
}

/** Throws record_limit (403) when adding `count` records would pass the account's limit. */
export async function assertCanAddRecords(db: Db, userId: string, count = 1): Promise<void> {
  const u = await recordUsage(userId, db);
  if (u.used + count <= u.limit) return;
  const left = Math.max(0, u.limit - u.used);
  const msg = u.pro
    ? `You have ${u.used} of ${u.limit} records. Delete old ones to add more${count > 1 ? ` (room for ${left})` : ""}.`
    : `Free accounts keep up to ${u.limit} records and you have ${u.used}. Nabikaran Pro keeps up to ${u.proLimit}, or delete old ones${count > 1 ? ` (room for ${left})` : ""}.`;
  throw new HttpError(403, msg, "record_limit", { used: u.used, limit: u.limit, pro: u.pro, proLimit: u.proLimit, left });
}
