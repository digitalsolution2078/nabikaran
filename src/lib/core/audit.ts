import type { Db } from "../db";
import type { Principal } from "./principal";

/** Append an audit row attributed to the acting principal and channel. */
export async function audit(
  db: Db,
  p: Principal | null,
  action: string,
  target: { type: string; id: string } | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into audit_events (actor_user_id, actor_via, actor_client_id, actor_token_id, action, target_type, target_id, json_detail_redacted)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      p?.userId ?? null,
      p?.via ?? "system",
      p?.clientId ?? null,
      p?.tokenId ?? null,
      action,
      target?.type ?? null,
      target?.id ?? null,
      detail ? JSON.stringify(detail) : null,
    ],
  );
}
