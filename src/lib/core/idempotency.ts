import type { Db } from "../db";
import { HttpError } from "./errors";

export interface IdempotentResult<T> {
  result: T;
  replayed: boolean;
}

/**
 * Run `fn` at most once per (user, key). Must be called inside a transaction
 * (`db.tx`): the key row is inserted first so a concurrent duplicate blocks on
 * the primary key until this transaction commits, then sees the stored
 * response and replays it instead of re-running the mutation.
 *
 * `operation` guards against reusing one key for a different kind of call.
 */
export async function withIdempotency<T>(
  tx: Db,
  userId: string,
  key: string | undefined | null,
  operation: string,
  fn: () => Promise<T>,
): Promise<IdempotentResult<T>> {
  if (!key) return { result: await fn(), replayed: false };
  if (key.length > 64) throw new HttpError(400, "idempotency key too long", "invalid_idempotency_key");

  const { rows } = await tx.query<{ key: string }>(
    "insert into idempotency_keys (user_id, key, operation) values ($1, $2, $3) on conflict (user_id, key) do nothing returning key",
    [userId, key, operation],
  );
  if (rows.length === 0) {
    const { rows: prior } = await tx.query<{ operation: string; response: T | null }>(
      "select operation, response from idempotency_keys where user_id = $1 and key = $2",
      [userId, key],
    );
    const p = prior[0];
    if (!p) throw new HttpError(409, "idempotency key in progress", "idempotency_conflict");
    if (p.operation !== operation) throw new HttpError(409, "idempotency key used for a different operation", "idempotency_conflict");
    if (p.response === null) throw new HttpError(409, "idempotency key in progress", "idempotency_conflict");
    return { result: p.response, replayed: true };
  }
  const result = await fn();
  await tx.query("update idempotency_keys set response = $3 where user_id = $1 and key = $2", [userId, key, JSON.stringify(result)]);
  return { result, replayed: false };
}
