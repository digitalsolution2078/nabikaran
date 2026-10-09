import { getDb, type Db } from "../db";
import { env } from "../env";
import { getSetting } from "./settings";

/** Operations dashboard: per-channel message pipeline, money, and provider health. */
export interface ChannelOps {
  scheduled: number;
  awaitingCredits: number;
  accepted: number;
  delivered: number;
  read: number;
  failed: number;
  unknown: number;
  acceptedLast7d: number;
  deliveredLast7d: number;
  creditsSpent30d: number;
  creditsRefunded30d: number;
  lastAttemptAt: string | null;
  lastAttemptState: string | null;
  lastError: string | null;
}

export interface Ops {
  sms: ChannelOps;
  whatsapp: ChannelOps & { enabled: boolean; providerMode: string; tokenConfigured: boolean; appSecretConfigured: boolean; verifyTokenConfigured: boolean; phoneNumberIdSet: boolean; lastWebhookAt: string | null; lastWebhookSignatureOk: boolean | null; webhookVerifiedAt: string | null };
  lowBalance: Array<{ id: string; phone: string; name: string | null; available: number; pending: number }>;
  dispatcher: { lastDispatchAt: string | null; lastReconcileAt: string | null; minutesSinceDispatch: number | null };
  smsProvider: { mode: string; tokenConfigured: boolean; reportsLast7d: number; reportsUnknownLast7d: number };
}

const iso = (v: unknown) => (v ? (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString()) : null);

async function channelOps(db: Db, ch: "sms" | "whatsapp"): Promise<ChannelOps> {
  const { rows } = await db.query<Record<string, string | null>>(
    `select
       (select count(*) from reminder_jobs where channel = $1 and status in ('scheduled','planned','sending'))::text as scheduled,
       (select count(*) from reminder_jobs where channel = $1 and status = 'awaiting_credits')::text as awaiting,
       (select count(*) from reminder_jobs where channel = $1 and status in ('submitted','delivered','read'))::text as accepted,
       (select count(*) from reminder_jobs where channel = $1 and status in ('delivered','read'))::text as delivered,
       (select count(*) from reminder_jobs where channel = $1 and status = 'read')::text as read,
       (select count(*) from reminder_jobs where channel = $1 and status = 'failed')::text as failed,
       (select count(*) from reminder_jobs where channel = $1 and status = 'unknown')::text as unknown,
       (select count(*) from sms_attempts where channel = $1 and api_state = 'accepted' and request_at > now() - interval '7 days')::text as acc7,
       (select count(*) from sms_attempts where channel = $1 and delivered_at is not null and request_at > now() - interval '7 days')::text as del7,
       (select coalesce(-sum(l.signed_credits),0) from wallet_ledger l join reminder_jobs j on l.reference_type = 'reminder_job' and j.id::text = l.reference_id
          where l.type = 'debit' and j.channel = $1 and l.created_at > now() - interval '30 days')::text as spent30,
       (select coalesce(sum(l.signed_credits),0) from wallet_ledger l join reminder_jobs j on l.reference_type = 'reminder_job' and j.id::text = l.reference_id
          where l.type = 'reversal' and j.channel = $1 and l.created_at > now() - interval '30 days')::text as refunded30`,
    [ch],
  );
  const { rows: last } = await db.query<{ request_at: unknown; api_state: string; error_text: string | null }>(
    "select request_at, api_state, error_text from sms_attempts where channel = $1 order by request_at desc limit 1",
    [ch],
  );
  const r = rows[0];
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    scheduled: n("scheduled"), awaitingCredits: n("awaiting"), accepted: n("accepted"), delivered: n("delivered"), read: n("read"),
    failed: n("failed"), unknown: n("unknown"), acceptedLast7d: n("acc7"), deliveredLast7d: n("del7"),
    creditsSpent30d: n("spent30"), creditsRefunded30d: n("refunded30"),
    lastAttemptAt: iso(last[0]?.request_at), lastAttemptState: last[0]?.api_state ?? null, lastError: last[0]?.error_text ?? null,
  };
}

export async function getOps(db: Db = getDb(), lowBalanceThreshold = 10): Promise<Ops> {
  const [sms, wa, waSettings, low, beats, webhook, verified, reports] = await Promise.all([
    channelOps(db, "sms"),
    channelOps(db, "whatsapp"),
    getSetting("whatsapp", db),
    db.query<{ id: string; phone_e164: string; display_name: string | null; available: string; pending: string }>(
      `select u.id, u.phone_e164, u.display_name, (w.posted_balance_credits - w.reserved_credits)::text as available,
              (select count(*) from reminder_jobs j where j.user_id = u.id and j.status = 'awaiting_credits')::text as pending
         from users u join wallets w on w.user_id = u.id
        where u.role = 'user' and u.status = 'active' and (w.posted_balance_credits - w.reserved_credits) < $1
          and exists (select 1 from renewal_items i where i.owner_user_id = u.id and i.status = 'active')
        order by (w.posted_balance_credits - w.reserved_credits) asc limit 20`,
      [lowBalanceThreshold],
    ),
    db.query<{ target_id: string; at: unknown }>(
      "select target_id, max(created_at) as at from audit_events where action = 'worker.heartbeat' and created_at > now() - interval '7 days' group by target_id",
    ),
    db.query<{ received_at: unknown; signature_valid: boolean }>("select received_at, signature_valid from whatsapp_webhook_events where kind <> 'verify' order by received_at desc limit 1"),
    db.query<{ received_at: unknown }>("select received_at from whatsapp_webhook_events where kind = 'verify' and status = 'verified' order by received_at desc limit 1"),
    db.query<{ total: string; unknown: string }>(
      `select count(*) filter (where reported_status is not null)::text as total,
              count(*) filter (where api_state = 'accepted' and reported_status is null and request_at < now() - interval '1 day')::text as unknown
         from sms_attempts where channel = 'sms' and request_at > now() - interval '7 days'`,
    ),
  ]);
  const beat = (k: string) => iso(beats.rows.find((b) => b.target_id === k)?.at);
  const lastDispatchAt = beat("dispatch");
  return {
    sms,
    whatsapp: {
      ...wa,
      enabled: waSettings.enabled,
      providerMode: env.whatsapp.provider,
      tokenConfigured: Boolean(env.whatsapp.accessToken),
      appSecretConfigured: Boolean(env.whatsapp.appSecret),
      verifyTokenConfigured: Boolean(env.whatsapp.verifyToken),
      phoneNumberIdSet: Boolean(waSettings.phone_number_id),
      lastWebhookAt: iso(webhook.rows[0]?.received_at),
      lastWebhookSignatureOk: webhook.rows[0] ? webhook.rows[0].signature_valid : null,
      webhookVerifiedAt: iso(verified.rows[0]?.received_at),
    },
    lowBalance: low.rows.map((r) => ({ id: r.id, phone: r.phone_e164, name: r.display_name, available: Number(r.available), pending: Number(r.pending) })),
    dispatcher: {
      lastDispatchAt,
      lastReconcileAt: beat("reconcile"),
      minutesSinceDispatch: lastDispatchAt ? Math.floor((Date.now() - new Date(lastDispatchAt).getTime()) / 60000) : null,
    },
    smsProvider: { mode: env.smsProvider, tokenConfigured: Boolean(env.aakash.authToken), reportsLast7d: Number(reports.rows[0]?.total ?? 0), reportsUnknownLast7d: Number(reports.rows[0]?.unknown ?? 0) },
  };
}
