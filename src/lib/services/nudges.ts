import { getDb, type Db } from "../db";
import { env } from "../env";
import { getSmsProvider } from "../providers/sms";
import { getEmailProvider, textToHtml } from "../providers/email";
import { utcToKathmandu } from "../time";
import { sendPushToUser } from "./push";
import { getSetting, NUDGE_LINK } from "./settings";

/**
 * "Set your first reminder" nudges for people who signed up but never added a
 * reminder. Three steps by account age (Admin → Settings → First-reminder nudges):
 *   first — app notification + email (free)
 *   sms   — one SMS with the add-reminder link (costs the business one SMS)
 *   last  — app notification + email (free)
 * Each step goes once per person, at most one nudge per 20 hours, 10 am–7 pm
 * Nepal time, only to accounts younger than `window_days`, and never to people
 * who turned nudges off in Settings. The add-reminder page offers a free app
 * reminder, so a nudge never asks anyone to pay first.
 */
const DAY = 86_400_000;
const appUrl = () => env.appUrl.replace(/\/$/, "");

export type NudgeStage = "first" | "sms" | "last";

export function nudgeStage(ageDays: number, s: { first_days: number; sms_days: number; last_days: number; sms: boolean }): NudgeStage | null {
  if (ageDays >= s.last_days) return "last";
  if (s.sms && ageDays >= s.sms_days) return "sms";
  if (ageDays >= s.first_days) return "first";
  return null;
}

const COPY: Record<"first" | "last", { title: string; body: string; email: string[] }> = {
  first: {
    title: "Your first reminder takes 1 minute",
    body: "Add your bluebook, licence or insurance renewal date. We remind you on time. App reminders are free.",
    email: [
      "Welcome to Nabikaran.",
      "",
      "Add the date of something you must renew (bike or car bluebook, driving licence, insurance, passport, a subscription) and we remind you before it is due.",
      "",
      "- App notifications are free.",
      "- SMS, WhatsApp and email reminders use wallet credits (shown before you save).",
      "",
    ],
  },
  last: {
    title: "Don't miss a renewal fine",
    body: "A late bluebook or licence renewal costs a fine. Add the date once and Nabikaran reminds you every time.",
    email: [
      "A late renewal often means a fine or a lapsed policy.",
      "",
      "Add the date once and Nabikaran reminds you before it is due, every time it comes round. App reminders are free.",
      "",
    ],
  },
};

/** Send due nudges. Returns how many people were nudged. Run from the reconciler. */
export async function runNudges(db: Db = getDb(), now: Date = new Date(), limit = 100): Promise<number> {
  const s = await getSetting("nudges", db);
  if (!s.enabled) return 0;
  const hour = utcToKathmandu(now).hour;
  if (hour < 10 || hour >= 19) return 0;
  const { rows } = await db.query<{ id: string; phone_e164: string; email: string | null; verified: boolean; created_at: unknown }>(
    `select u.id, u.phone_e164, u.email, (u.email_verified_at is not null) as verified, u.created_at
       from users u
      where u.role = 'user' and u.status = 'active' and not u.nudges_opt_out
        and u.created_at <= $1::timestamptz - make_interval(days => $2)
        and u.created_at > $1::timestamptz - make_interval(days => $3)
        and not exists (select 1 from renewal_items i where i.owner_user_id = u.id)
        and not exists (select 1 from user_notices n where n.user_id = u.id and n.key like 'nudge:%' and n.created_at > $1::timestamptz - interval '20 hours')
      order by u.created_at limit $4`,
    [now.toISOString(), s.first_days, s.window_days, limit],
  );
  if (!rows.length) return 0;
  const email = await getEmailProvider(db);
  let sent = 0;
  for (const u of rows) {
    const created = u.created_at instanceof Date ? u.created_at : new Date(String(u.created_at));
    const stage = nudgeStage((now.getTime() - created.getTime()) / DAY, s);
    if (!stage) continue;
    const key = `nudge:${stage}:${u.id}`;
    // Recorded first, so a crash never sends twice.
    const { rows: ins } = await db.query("insert into user_notices (key, user_id, created_at) values ($1, $2, $3) on conflict (key) do nothing returning key", [key, u.id, now.toISOString()]);
    if (!ins[0]) continue;
    const channels: string[] = [];
    const attempt = async (name: string, fn: () => Promise<boolean>) => {
      try {
        if (await fn()) channels.push(name);
      } catch (e) {
        console.warn(`[nudge] ${name}: ${(e as Error).message}`);
      }
    };
    if (stage === "sms") {
      const text = s.sms_text.replace("{link}", NUDGE_LINK);
      await attempt("sms", async () => (await getSmsProvider().send({ to: u.phone_e164, text, idempotencyKey: key })).kind === "accepted");
    } else {
      const c = COPY[stage];
      await attempt("push", async () => (await sendPushToUser(u.id, { title: c.title, body: c.body, url: "/renewals/new", tag: "nudge" }, db)) > 0);
      if (email && u.email && u.verified) {
        const to = u.email;
        const text = [...c.email, `Add your first reminder: ${appUrl()}/renewals/new`, "", "Don't want these tips? Turn them off in Settings."].join("\n");
        await attempt("email", async () => (await email.send({ to, subject: `Nabikaran: ${c.title}`, text, html: textToHtml(text, { href: `${appUrl()}/renewals/new`, label: "Add a reminder" }), idempotencyKey: key })).kind === "accepted");
      }
    }
    await db.query("insert into audit_events (actor_via, action, target_type, target_id, json_detail_redacted) values ('worker','nudge.sent','user',$1,$2)", [
      u.id, JSON.stringify({ stage, channels }),
    ]);
    if (channels.length) sent++;
  }
  return sent;
}

/** Admin: nudges sent in the last `days` days and how many of those people then added a reminder. */
export async function nudgeReport(db: Db = getDb(), days = 30): Promise<{ nudged: number; converted: number; byStage: Record<NudgeStage, number>; smsSent: number }> {
  const { rows } = await db.query<{ stage: string; n: number }>(
    `select split_part(key, ':', 2) as stage, count(*)::int as n from user_notices
      where key like 'nudge:%' and created_at > now() - make_interval(days => $1) group by 1`,
    [days],
  );
  const { rows: c } = await db.query<{ nudged: number; converted: number }>(
    `with first as (select user_id, min(created_at) as at from user_notices where key like 'nudge:%' and created_at > now() - make_interval(days => $1) group by user_id)
     select count(*)::int as nudged,
            count(*) filter (where exists (select 1 from renewal_items i where i.owner_user_id = f.user_id and i.created_at > f.at))::int as converted
       from first f`,
    [days],
  );
  const { rows: sms } = await db.query<{ n: number }>(
    "select count(*)::int as n from audit_events where action = 'nudge.sent' and created_at > now() - make_interval(days => $1) and json_detail_redacted->>'stage' = 'sms' and json_detail_redacted->'channels' ? 'sms'",
    [days],
  );
  const byStage = { first: 0, sms: 0, last: 0 } as Record<NudgeStage, number>;
  for (const r of rows) if (r.stage in byStage) byStage[r.stage as NudgeStage] = r.n;
  return { nudged: c[0]?.nudged ?? 0, converted: c[0]?.converted ?? 0, byStage, smsSent: sms[0]?.n ?? 0 };
}
