import { getDb, type Db } from "../db";
import { env } from "../env";
import { getSmsProvider } from "../providers/sms";
import { getEmailProvider, textToHtml } from "../providers/email";
import { formatKathmandu, utcToKathmandu } from "../time";
import { sendPushToUser } from "./push";
import { getSetting } from "./settings";

/**
 * "Your reminders can't be sent" alerts. Every message is funded when it is
 * saved, so a reminder in `awaiting_credits` will not go out unless the
 * customer tops up. Customers are told in three steps, keyed on the earliest
 * waiting message:
 *   new  — as soon as it is noticed (app notification + email)
 *   soon — 7 days before it is due (app notification + email)
 *   last — `last_call_days` before it is due (the above, plus one SMS when on)
 * Each step goes once (user_notices), at most one alert per customer per day,
 * in Nepal daytime only. Free for the customer. Messages waiting for Pro
 * permission ("use wallet credits") are a different question and are skipped.
 */
const DAY = 86_400_000;
const appUrl = () => env.appUrl.replace(/\/$/, "");
const shortUrl = () => appUrl().replace(/^https?:\/\//, "");

export type LowCreditStage = "new" | "soon" | "last";

export interface Shortfall {
  userId: string;
  waiting: number;
  needed: number;
  available: number;
  /** Whole rupees to top up: at least the shortfall and the minimum top-up. */
  topUpNpr: number;
  firstJobId: string;
  firstDueAt: string;
}

export function stageFor(firstDueAt: Date, now: Date, lastCallDays: number): LowCreditStage {
  const days = (firstDueAt.getTime() - now.getTime()) / DAY;
  if (days <= lastCallDays) return "last";
  if (days <= 7) return "soon";
  return "new";
}

/** Customers with reminders that cannot be sent for lack of credits. */
export async function findShortfalls(db: Db, now: Date, userId?: string): Promise<Shortfall[]> {
  const { min_npr } = await getSetting("topup", db);
  const { rows } = await db.query<{ user_id: string; waiting: number; needed: string; available: string; first_job: string; first_due: unknown }>(
    `select j.user_id, count(*)::int as waiting, sum(j.estimated_credits)::text as needed,
            (w.posted_balance_credits - w.reserved_credits)::text as available,
            (array_agg(j.id order by j.due_at_utc, j.id))[1]::text as first_job, min(j.due_at_utc) as first_due
       from reminder_jobs j
       join renewal_items i on i.id = j.renewal_id and i.status = 'active' and i.cycle_no = j.cycle_no
       join users u on u.id = j.user_id and u.status = 'active'
       join wallets w on w.user_id = j.user_id
      where j.status = 'awaiting_credits' and j.due_at_utc > $1
        and coalesce(j.last_error, '') not like 'included messages used up%'
        and ($2::uuid is null or j.user_id = $2::uuid)
      group by j.user_id, w.posted_balance_credits, w.reserved_credits
      limit 500`,
    [now.toISOString(), userId ?? null],
  );
  return rows.map((r) => {
    const needed = Number(r.needed);
    const available = Number(r.available);
    return {
      userId: r.user_id,
      waiting: r.waiting,
      needed,
      available,
      topUpNpr: Math.max(min_npr, Math.ceil(needed - Math.max(available, 0) - 1e-9)),
      firstJobId: r.first_job,
      firstDueAt: (r.first_due instanceof Date ? r.first_due : new Date(String(r.first_due))).toISOString(),
    };
  });
}

function messages(s: Shortfall, stage: LowCreditStage, now: Date) {
  const date = formatKathmandu(new Date(s.firstDueAt), false);
  const days = Math.max(0, Math.ceil((new Date(s.firstDueAt).getTime() - now.getTime()) / DAY));
  const what = s.waiting === 1 ? "1 reminder" : `${s.waiting} reminders`;
  const link = `${appUrl()}/wallet?amount=${s.topUpNpr}`;
  const title = stage === "last" ? `Last call: ${what} will not be sent` : `${what} cannot be sent: top up NPR ${s.topUpNpr}`;
  const text = [
    `${what} cannot be sent because your wallet is short of credits.`,
    "",
    `- Credits needed: ${s.needed.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
    `- Credits free in your wallet: ${Math.max(s.available, 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
    `- First one is due: ${date}${days <= 7 ? ` (${days === 0 ? "today" : `in ${days} day(s)`})` : ""}`,
    "",
    `Top up NPR ${s.topUpNpr} and they are scheduled automatically: ${link}`,
    "",
    "Reminders that are already scheduled are not affected.",
  ].join("\n");
  const sms = `Nabikaran: ${what} cannot be sent (first due ${date}). Top up NPR ${s.topUpNpr}: ${shortUrl()}/wallet`;
  const push = { title, body: `First due ${date}. Top up NPR ${s.topUpNpr} and they are sent on time.`, url: `/wallet?amount=${s.topUpNpr}`, tag: "low-credit" };
  return { title, text, sms, push, link };
}

/** Send due alerts. Returns how many customers were alerted. Run from the reconciler. */
export async function runLowCreditAlerts(db: Db = getDb(), now: Date = new Date()): Promise<number> {
  const settings = await getSetting("low_credit", db);
  if (!settings.enabled) return 0;
  const hour = utcToKathmandu(now).hour;
  if (hour < 8 || hour >= 20) return 0;
  const list = await findShortfalls(db, now);
  if (!list.length) return 0;
  const email = await getEmailProvider(db);
  let alerted = 0;
  for (const s of list) {
    const stage = stageFor(new Date(s.firstDueAt), now, settings.last_call_days);
    // At most one alert per customer per 20 hours, whatever the stage.
    const { rows: recent } = await db.query("select 1 from user_notices where user_id = $1 and key like 'low-credit:%' and created_at > $2 limit 1", [
      s.userId, new Date(now.getTime() - 20 * 3600_000).toISOString(),
    ]);
    if (recent[0]) continue;
    const key = `low-credit:${stage}:${s.firstJobId}`;
    // Recorded first, so a crash never sends twice (best effort, like the Pro notices).
    const { rows: ins } = await db.query("insert into user_notices (key, user_id, created_at) values ($1, $2, $3) on conflict (key) do nothing returning key", [key, s.userId, now.toISOString()]);
    if (!ins[0]) continue;
    const m = messages(s, stage, now);
    const channels: string[] = [];
    // Each channel on its own: one failing never stops the others.
    const attempt = async (name: string, fn: () => Promise<boolean>) => {
      try {
        if (await fn()) channels.push(name);
      } catch (e) {
        console.warn(`[low-credit] ${name}: ${(e as Error).message}`);
      }
    };
    const { rows: u } = await db.query<{ email: string | null; verified: boolean; phone_e164: string }>(
      "select email, (email_verified_at is not null) as verified, phone_e164 from users where id = $1", [s.userId],
    );
    await attempt("push", async () => (await sendPushToUser(s.userId, m.push, db)) > 0);
    if (email && u[0]?.email && u[0].verified) {
      const to = u[0].email;
      await attempt("email", async () => (await email.send({ to, subject: `Nabikaran: ${m.title}`, text: m.text, html: textToHtml(m.text, { href: m.link, label: `Top up NPR ${s.topUpNpr}` }), idempotencyKey: key })).kind === "accepted");
    }
    if (stage === "last" && settings.sms_last_call && u[0]?.phone_e164) {
      const to = u[0].phone_e164;
      await attempt("sms", async () => (await getSmsProvider().send({ to, text: m.sms, idempotencyKey: key })).kind === "accepted");
    }
    await db.query("insert into audit_events (actor_via, action, target_type, target_id, json_detail_redacted) values ('worker','low_credit.alert','user',$1,$2)", [
      s.userId, JSON.stringify({ stage, waiting: s.waiting, needed: s.needed, top_up_npr: s.topUpNpr, channels }),
    ]);
    alerted++;
  }
  return alerted;
}

/** Last alert per customer (admin overview). */
export async function lastLowCreditAlerts(userIds: string[], db: Db = getDb()): Promise<Map<string, { at: string; stage: string }>> {
  if (!userIds.length) return new Map();
  const { rows } = await db.query<{ user_id: string; key: string; created_at: unknown }>(
    `select distinct on (user_id) user_id, key, created_at from user_notices
      where user_id = any($1::uuid[]) and key like 'low-credit:%' order by user_id, created_at desc`,
    [userIds],
  );
  return new Map(rows.map((r) => [r.user_id, { at: (r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at))).toISOString(), stage: r.key.split(":")[1] }]));
}
