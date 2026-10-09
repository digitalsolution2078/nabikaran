import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env";
import { getDb, type Db } from "../db";
import { BOOKED_COMMIT } from "../services/billing";
import { getActivePricing } from "../core/wallet";
import { redactPhone } from "../phone";

/**
 * Meta WhatsApp Cloud API webhooks.
 *  GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…  → echo challenge
 *  POST  X-Hub-Signature-256: sha256=HMAC_SHA256(app_secret, raw body)
 *        entry[].changes[].value.statuses[]  { id, status: sent|delivered|read|failed, errors?, biz_opaque_callback_data? }
 *        entry[].changes[].value.messages[]  inbound user messages ("STOP" opts out)
 * Every POST is logged (whatsapp_webhook_events) with phone numbers redacted.
 */

export function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  let given: Buffer;
  try {
    given = Buffer.from(header.slice(7), "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function verifySubscription(params: URLSearchParams): string | null {
  const token = env.whatsapp.verifyToken;
  if (!token) return null;
  if (params.get("hub.mode") !== "subscribe") return null;
  const given = params.get("hub.verify_token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return params.get("hub.challenge");
}

interface MetaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  biz_opaque_callback_data?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}
interface MetaMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
}
interface MetaPayload {
  object?: string;
  entry?: Array<{ changes?: Array<{ field?: string; value?: { statuses?: MetaStatus[]; messages?: MetaMessage[] } }> }>;
}

const RANK: Record<string, number> = { sending: 0, unknown: 0, submitted: 1, delivered: 2, read: 3 };

export interface WebhookResult {
  ok: boolean;
  statuses: number;
  updated: number;
  refunded: number;
  optOuts: number;
}

export async function processWebhook(rawBody: string, signature: string | null, db: Db = getDb()): Promise<WebhookResult> {
  const result: WebhookResult = { ok: false, statuses: 0, updated: 0, refunded: 0, optOuts: 0 };
  const valid = verifySignature(rawBody, signature, env.whatsapp.appSecret);
  if (!valid) {
    await db.query("insert into whatsapp_webhook_events (signature_valid, kind) values (false, 'other')");
    await db.query("insert into audit_events (actor_via, action, json_detail_redacted) values ('system','whatsapp.webhook.rejected', $1)", [JSON.stringify({ reason: "bad signature" })]);
    return result;
  }
  let payload: MetaPayload;
  try {
    payload = JSON.parse(rawBody) as MetaPayload;
  } catch {
    await db.query("insert into whatsapp_webhook_events (signature_valid, kind) values (true, 'other')");
    return result;
  }
  result.ok = true;
  const statuses: MetaStatus[] = [];
  const messages: MetaMessage[] = [];
  for (const e of payload.entry ?? []) for (const c of e.changes ?? []) {
    statuses.push(...(c.value?.statuses ?? []));
    messages.push(...(c.value?.messages ?? []));
  }
  result.statuses = statuses.length;

  for (const st of statuses) {
    const errorCode = st.errors?.[0]?.code != null ? String(st.errors[0].code) : null;
    await db.query(
      "insert into whatsapp_webhook_events (signature_valid, kind, provider_message_id, status, error_code, payload_redacted) values (true, 'status', $1, $2, $3, $4)",
      [st.id ?? null, st.status ?? null, errorCode, JSON.stringify({ ...st, recipient_id: st.recipient_id ? redactPhone(`+${st.recipient_id}`) : undefined })],
    );
    const r = await applyStatus(st, db);
    if (r.updated) result.updated++;
    if (r.refunded) result.refunded++;
  }

  for (const m of messages) {
    await db.query("insert into whatsapp_webhook_events (signature_valid, kind, payload_redacted) values (true, 'message', $1)", [
      JSON.stringify({ type: m.type, from: m.from ? redactPhone(`+${m.from}`) : undefined }),
    ]);
    const text = (m.text?.body ?? m.button?.text ?? "").trim().toLowerCase();
    if (m.from && /^(stop|unsubscribe|band garnus|band)$/.test(text)) {
      const { rowCount } = await db.query("update users set whatsapp_opt_in_at = null where phone_e164 = $1 and whatsapp_opt_in_at is not null", [`+${m.from}`]);
      if (rowCount) {
        result.optOuts++;
        await db.query("insert into audit_events (actor_via, action, json_detail_redacted) values ('system','whatsapp.opt_out', $1)", [JSON.stringify({ from: redactPhone(`+${m.from}`) })]);
      }
    }
  }

  await db.query("insert into audit_events (actor_via, action, json_detail_redacted) values ('system','whatsapp.webhook.received', $1)", [
    JSON.stringify({ statuses: result.statuses, updated: result.updated, refunded: result.refunded, messages: messages.length }),
  ]);
  return result;
}

async function applyStatus(st: MetaStatus, db: Db): Promise<{ updated: boolean; refunded: boolean }> {
  const status = (st.status ?? "").toLowerCase();
  if (!st.id || !["sent", "delivered", "read", "failed"].includes(status)) return { updated: false, refunded: false };
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ id: string; job_id: string; idempotency_key: string; api_state: string; job_status: string; estimated_segments: number }>(
      `select a.id, a.job_id, a.idempotency_key, a.api_state, j.status as job_status, j.estimated_segments
         from sms_attempts a join reminder_jobs j on j.id = a.job_id
        where a.channel = 'whatsapp' and (a.provider_message_id = $1 or ($2::text is not null and a.idempotency_key = $2::text))
        order by a.attempt_no desc limit 1 for update of a, j`,
      [st.id, st.biz_opaque_callback_data ?? null],
    );
    const a = rows[0];
    if (!a) return { updated: false, refunded: false };

    // An attempt we marked "unknown" (timeout) is now known to be accepted: charge it once.
    if (status !== "failed" && (a.api_state === "unknown" || a.api_state === "pending")) {
      const price = (await getActivePricing(tx, "whatsapp")).creditsPerUnit;
      await tx.query("update sms_attempts set api_state = 'accepted', provider_message_id = coalesce(provider_message_id, $2), response_at = now() where id = $1", [a.id, st.id]);
      const { rows: res } = await tx.query<{ status: string }>("select status from credit_reservations where reminder_job_id = $1", [a.job_id]);
      if (res[0]?.status === "active") await tx.query(BOOKED_COMMIT, [a.job_id, a.estimated_segments || 1, price, `debit:${a.idempotency_key}`]);
    }

    let updated = false;
    let refunded = false;
    if (status === "failed") {
      if (a.job_status === "delivered" || a.job_status === "read" || a.job_status === "failed") return { updated: false, refunded: false };
      const reason = `meta ${st.errors?.[0]?.code ?? ""} ${st.errors?.[0]?.title ?? st.errors?.[0]?.message ?? "failed"}`.trim();
      const { rows: charged } = await tx.query("select 1 from wallet_ledger where idempotency_key = $1", [`debit:${a.idempotency_key}`]);
      if (charged.length) {
        await tx.query("select wallet_reverse_debit_for_job($1, $2)", [a.job_id, `debit:${a.idempotency_key}`]);
        refunded = true;
      } else {
        await tx.query("select wallet_release_for_job($1)", [a.job_id]);
      }
      await tx.query("update sms_attempts set reported_status = 'failed', error_text = $2, refunded_at = case when $3 then now() else refunded_at end where id = $1", [a.id, reason, refunded]);
      await tx.query("update reminder_jobs set status = 'failed', last_error = $2, updated_at = now() where id = $1", [a.job_id, reason]);
      await tx.query("insert into audit_events (actor_via, action, target_type, target_id, json_detail_redacted) values ('system','whatsapp.message.failed','reminder_job',$1,$2)", [
        a.job_id, JSON.stringify({ reason, refunded }),
      ]);
      return { updated: true, refunded };
    }

    const target = status === "sent" ? "submitted" : status;
    if ((RANK[target] ?? 0) > (RANK[a.job_status] ?? -1) && a.job_status !== "failed" && a.job_status !== "cancelled") {
      await tx.query("update reminder_jobs set status = $2, last_error = null, updated_at = now() where id = $1", [a.job_id, target]);
      updated = true;
    }
    if (status === "delivered" || status === "read") {
      await tx.query(
        `update sms_attempts set reported_status = $2,
            delivered_at = coalesce(delivered_at, now()),
            read_at = case when $2 = 'read' then coalesce(read_at, now()) else read_at end
          where id = $1`,
        [a.id, status],
      );
      if (updated) {
        await tx.query("insert into audit_events (actor_via, action, target_type, target_id) values ('system',$1,'reminder_job',$2)", [`whatsapp.message.${status}`, a.job_id]);
      }
    }
    return { updated, refunded };
  });
}
