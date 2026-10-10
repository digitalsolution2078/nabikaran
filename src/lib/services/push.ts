import webpush from "web-push";
import { z } from "zod";
import { getDb, type Db } from "../db";
import { env } from "../env";

/**
 * Free web push notifications (PWA). A push goes out alongside each reminder
 * message the dispatcher sends; it costs no credits and never blocks or
 * changes the SMS / WhatsApp send. VAPID keys come from VAPID_PUBLIC_KEY /
 * VAPID_PRIVATE_KEY when set, otherwise the app creates a key pair once and
 * keeps it in app_secrets (server-only).
 */

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cached: VapidKeys | null = null;

export async function getVapidKeys(db: Db = getDb()): Promise<VapidKeys> {
  if (cached) return cached;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (pub && priv) return (cached = { publicKey: pub, privateKey: priv });
  const read = async () => {
    const { rows } = await db.query<{ value: VapidKeys }>("select value from app_secrets where key = 'vapid'");
    return rows[0]?.value ?? null;
  };
  let keys = await read();
  if (!keys) {
    const k = webpush.generateVAPIDKeys();
    // Two instances starting together: the first insert wins and both read it back.
    await db.query("insert into app_secrets (key, value) values ('vapid', $1) on conflict (key) do nothing", [JSON.stringify(k)]);
    keys = await read();
  }
  if (!keys) throw new Error("VAPID keys unavailable");
  return (cached = keys);
}

/** Test hook: forget the cached key pair. */
export function resetVapidCache() {
  cached = null;
}

const subject = () => process.env.VAPID_SUBJECT || (env.appUrl.startsWith("https://") ? env.appUrl : "mailto:support@nabikaran.org");

/** Browser push services only: the server never posts to any other host. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];
export function isPushServiceUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && !url.port && PUSH_HOSTS.some((h) => h.test(url.hostname));
  } catch {
    return false;
  }
}

export const subscriptionSchema = z.object({
  endpoint: z.string().max(1000).refine(isPushServiceUrl, "unsupported push service"),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
});
export type PushSubscriptionInput = z.infer<typeof subscriptionSchema>;

const MAX_DEVICES = 10;

export async function savePushSubscription(userId: string, sub: PushSubscriptionInput, userAgent: string | null, db: Db = getDb()): Promise<number> {
  return db.tx(async (tx) => {
    // An endpoint belongs to one browser profile; if another account used this
    // browser before, the newest sign-in takes it over.
    await tx.query(
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) values ($1,$2,$3,$4,$5)
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, failure_count = 0, created_at = now()`,
      [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 200) ?? null],
    );
    // Keep the newest devices only.
    await tx.query(
      `delete from push_subscriptions where user_id = $1 and id not in
         (select id from push_subscriptions where user_id = $1 order by created_at desc limit ${MAX_DEVICES})`,
      [userId],
    );
    return deviceCount(userId, tx);
  });
}

export async function removePushSubscription(userId: string, endpoint: string | null, db: Db = getDb()): Promise<number> {
  if (endpoint) await db.query("delete from push_subscriptions where user_id = $1 and endpoint = $2", [userId, endpoint]);
  else await db.query("delete from push_subscriptions where user_id = $1", [userId]);
  return deviceCount(userId, db);
}

export async function deviceCount(userId: string, db: Db = getDb()): Promise<number> {
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from push_subscriptions where user_id = $1", [userId]);
  return rows[0]?.n ?? 0;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

/** Sender seam so tests run without the network. */
export type PushSender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, keys: VapidKeys) => Promise<{ statusCode: number }>;

const defaultSender: PushSender = (sub, payload, keys) =>
  webpush.sendNotification(sub, payload, { TTL: 24 * 3600, urgency: "high", timeout: 8000, vapidDetails: { subject: subject(), ...keys } });

let sender: PushSender = defaultSender;
export function setPushSender(s: PushSender | null) {
  sender = s ?? defaultSender;
}

/** Send to every device of a user. Expired endpoints (404/410) are removed. Returns devices reached. */
export async function sendPushToUser(userId: string, payload: PushPayload, db: Db = getDb()): Promise<number> {
  const { rows } = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    "select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1",
    [userId],
  );
  if (!rows.length) return 0;
  const keys = await getVapidKeys(db);
  const body = JSON.stringify({ ...payload, body: payload.body.slice(0, 300) });
  let ok = 0;
  await Promise.all(
    rows.map(async (r) => {
      try {
        await sender({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, body, keys);
        ok++;
        await db.query("update push_subscriptions set last_success_at = now(), failure_count = 0 where id = $1", [r.id]);
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? 0;
        if (status === 404 || status === 410) await db.query("delete from push_subscriptions where id = $1", [r.id]);
        else await db.query("update push_subscriptions set failure_count = failure_count + 1 where id = $1", [r.id]);
        // A device that keeps failing for other reasons is dropped after 20 tries.
        await db.query("delete from push_subscriptions where id = $1 and failure_count >= 20", [r.id]);
      }
    }),
  );
  return ok;
}

export interface ReminderPush {
  userId: string;
  renewalId: string;
  /** One push per reminder occurrence: renewal + rule + cycle. */
  occurrenceKey: string;
  body: string;
}

/**
 * Called by the dispatcher for jobs it is about to send. Best effort: errors are
 * logged and swallowed, and each occurrence is pushed at most once.
 */
export async function pushReminders(items: ReminderPush[], db: Db = getDb()): Promise<number> {
  let sent = 0;
  for (const it of items) {
    try {
      const { rows } = await db.query<{ key: string }>(
        `insert into push_deliveries (key, user_id) select $1, $2
          where exists (select 1 from push_subscriptions where user_id = $2)
         on conflict (key) do nothing returning key`,
        [`reminder:${it.occurrenceKey}`, it.userId],
      );
      if (!rows[0]) continue;
      const n = await sendPushToUser(it.userId, { title: "Nabikaran", body: it.body, url: `/renewals/${it.renewalId}`, tag: `r-${it.renewalId}` }, db);
      await db.query("update push_deliveries set sent = $2 where key = $1", [`reminder:${it.occurrenceKey}`, n]);
      sent += n;
    } catch (e) {
      console.warn(`[push] reminder push failed: ${(e as Error).message}`);
    }
  }
  return sent;
}
