import type { Db } from "../db";
import { RateLimitError } from "./errors";

export interface RateLimitRule {
  /** e.g. "tool:prepare_reminder" or "api:write" */
  bucket: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Fixed-window counter in Postgres (request_counters). One upsert per check;
 * throws RateLimitError when the window's count exceeds the limit.
 */
export async function checkRateLimit(db: Db, subject: string, rule: RateLimitRule, now: Date = new Date()): Promise<{ remaining: number }> {
  const windowStart = new Date(Math.floor(now.getTime() / (rule.windowSeconds * 1000)) * rule.windowSeconds * 1000);
  const { rows } = await db.query<{ n: number }>(
    `insert into request_counters (subject, bucket, window_start, n) values ($1, $2, $3, 1)
     on conflict (subject, bucket, window_start) do update set n = request_counters.n + 1
     returning n`,
    [subject, rule.bucket, windowStart.toISOString()],
  );
  const n = Number(rows[0]?.n ?? 1);
  if (n > rule.limit) {
    const retry = Math.ceil((windowStart.getTime() + rule.windowSeconds * 1000 - now.getTime()) / 1000);
    throw new RateLimitError(Math.max(1, retry));
  }
  return { remaining: rule.limit - n };
}

/** Metrics counter (hourly buckets, never throws). Read back with sumEvents(). */
export async function countEvent(db: Db, bucket: string, now: Date = new Date()): Promise<void> {
  const windowStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  await db
    .query("insert into request_counters (subject, bucket, window_start, n) values ('metrics', $1, $2, 1) on conflict (subject, bucket, window_start) do update set n = request_counters.n + 1", [bucket, windowStart.toISOString()])
    .catch(() => undefined);
}

export async function sumEvents(db: Db, bucket: string, sinceHours = 24): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "select coalesce(sum(n),0)::text as n from request_counters where subject = 'metrics' and bucket = $1 and window_start > now() - make_interval(hours => $2)",
    [bucket, sinceHours],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Housekeeping for the reconciler: drop windows older than a day. */
export async function pruneRateLimitWindows(db: Db): Promise<number> {
  const { rowCount } = await db.query("delete from request_counters where window_start < now() - interval '1 day' and subject <> 'metrics'");
  await db.query("delete from request_counters where subject = 'metrics' and window_start < now() - interval '30 days'");
  return rowCount ?? 0;
}
