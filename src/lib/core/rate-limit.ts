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

/** Housekeeping for the reconciler: drop windows older than a day. */
export async function pruneRateLimitWindows(db: Db): Promise<number> {
  const { rowCount } = await db.query("delete from request_counters where window_start < now() - interval '1 day'");
  return rowCount ?? 0;
}
