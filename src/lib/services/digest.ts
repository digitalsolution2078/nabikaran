import { getDb, type Db } from "../db";
import { env } from "../env";
import { getEmailProvider, textToHtml } from "../providers/email";
import { formatKathmandu, utcToKathmandu } from "../time";
import { getInsights } from "./insights";
import { sendPushToUser } from "./push";

/**
 * Pro email summaries (weekly or monthly) and "Pro is ending" notices.
 * Both are free (they do not use included messages or credits). Run from the
 * reconciler; each is sent at most once per period / per plan.
 */
const DAY = 86_400_000;
const appUrl = () => env.appUrl.replace(/\/$/, "");
const money = (currency: string | null, n: number) => `${currency ?? "NPR"} ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export async function buildDigest(userId: string, db: Db, now: Date): Promise<{ subject: string; text: string } | null> {
  const ins = await getInsights(userId, db, now);
  const lines: string[] = [];
  if (ins.cancelAlerts.length) {
    lines.push("Cancellation deadlines:");
    for (const c of ins.cancelAlerts) lines.push(`- Last day to cancel ${c.label}: ${formatKathmandu(new Date(c.dueAt), false)}`);
    lines.push("");
  }
  if (ins.trialsEnding.length) {
    lines.push("Free trials ending:");
    for (const t of ins.trialsEnding) lines.push(`- ${t.label}: ${formatKathmandu(new Date(t.dueAt), false)}${t.amount !== null ? ` (then ${money(t.currency, t.amount)})` : ""}`);
    lines.push("");
  }
  if (ins.deadlines30.length) {
    lines.push("Coming up in the next 30 days:");
    for (const d of ins.deadlines30.slice(0, 15)) lines.push(`- ${d.label}: ${formatKathmandu(new Date(d.dueAt), false)}${d.amount !== null ? ` · ${money(d.currency, d.amount)}` : ""}`);
    if (ins.deadlines30.length > 15) lines.push(`- …and ${ins.deadlines30.length - 15} more`);
    lines.push("");
  }
  if (ins.totals.length) {
    lines.push(`Your subscriptions (${ins.subscriptionCount}): ${ins.totals.map((t) => `${money(t.currency, t.monthly)} a month`).join(", ")}, from the amounts you entered.`);
    lines.push("");
  }
  if (!lines.length) return null; // nothing to say: skip this one
  return {
    subject: ins.cancelAlerts.length ? `Nabikaran: ${ins.cancelAlerts.length} cancellation deadline(s) coming up` : "Nabikaran: your upcoming deadlines",
    text: `Here is your Nabikaran summary.\n\n${lines.join("\n")}\nChange how often you get this in Settings → Email.`,
  };
}

/** Send due summaries (Nepal daytime only). Returns how many were sent. */
export async function runDigests(db: Db = getDb(), now: Date = new Date(), limit = 50): Promise<number> {
  const hour = utcToKathmandu(now).hour;
  if (hour < 7 || hour >= 20) return 0;
  const provider = await getEmailProvider(db);
  if (!provider) return 0;
  const { rows } = await db.query<{ id: string; email: string; digest_frequency: string }>(
    `select u.id, u.email, u.digest_frequency from users u
      where u.status = 'active' and u.email is not null and u.email_verified_at is not null and u.digest_frequency <> 'off'
        and exists (select 1 from user_plans p where p.user_id = u.id and p.status = 'active' and p.starts_at <= $1 and p.ends_at > $1)
        and (u.last_digest_at is null or u.last_digest_at < $1::timestamptz - case when u.digest_frequency = 'monthly' then interval '30 days' else interval '7 days' end)
      order by u.last_digest_at nulls first limit $2`,
    [now.toISOString(), limit],
  );
  let sent = 0;
  for (const u of rows) {
    try {
      // Mark first so a crash never sends twice; a failed send waits for the next period.
      await db.query("update users set last_digest_at = $2 where id = $1", [u.id, now.toISOString()]);
      const d = await buildDigest(u.id, db, now);
      if (!d) continue;
      const out = await provider.send({
        to: u.email, subject: d.subject, text: d.text, html: textToHtml(d.text, { href: `${appUrl()}/dashboard`, label: "Open Nabikaran" }),
        idempotencyKey: `digest-${u.id}-${now.toISOString().slice(0, 10)}`,
      });
      if (out.kind === "accepted") sent++;
    } catch (e) {
      console.warn(`[digest] ${(e as Error).message}`);
    }
  }
  return sent;
}

/**
 * "Pro ends soon" notices: 14 and 3 days before a paid/given plan ends (unless
 * another year is already bought), and 2 days before a free trial ends. By email
 * (when verified) and push. Says exactly what changes; nothing is cancelled.
 */
export async function runProNotices(db: Db = getDb(), now: Date = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: string; user_id: string; kind: string; ends_at: string; email: string | null; verified: boolean }>(
    `select p.id, p.user_id, p.kind, p.ends_at, u.email, (u.email_verified_at is not null) as verified
       from user_plans p join users u on u.id = p.user_id
      where p.status = 'active' and p.starts_at <= $1 and p.ends_at > $1 and p.ends_at <= $1::timestamptz + interval '14 days'
        and u.status = 'active'
        and not exists (select 1 from user_plans q where q.user_id = p.user_id and q.status = 'active' and q.starts_at >= p.ends_at - interval '1 minute' and q.id <> p.id)
      limit 200`,
    [now.toISOString()],
  );
  const provider = rows.length ? await getEmailProvider(db) : null;
  let sent = 0;
  for (const p of rows) {
    const daysLeft = Math.ceil((new Date(p.ends_at).getTime() - now.getTime()) / DAY);
    const stage = p.kind === "trial" ? (daysLeft <= 2 ? "trial-2" : null) : daysLeft <= 3 ? "end-3" : daysLeft <= 14 ? "end-14" : null;
    if (!stage) continue;
    const key = `pro-${stage}:${p.id}`;
    const { rows: ins } = await db.query("insert into user_notices (key, user_id) values ($1, $2) on conflict (key) do nothing returning key", [key, p.user_id]);
    if (!ins[0]) continue;
    const { rows: after } = await db.query<{ n: number }>(
      "select count(*)::int as n from reminder_jobs where user_id = $1 and status in ('scheduled','planned','awaiting_credits') and due_at_utc >= $2",
      [p.user_id, p.ends_at],
    );
    const date = formatKathmandu(new Date(p.ends_at), false);
    const title = p.kind === "trial" ? `Your Nabikaran Pro trial ends on ${date}` : `Your Nabikaran Pro ends on ${date}`;
    const text = [
      `${title} (${daysLeft} day(s) left).`,
      "",
      "After that:",
      "- your reminders, subscriptions and history stay as they are;",
      after[0].n > 0 ? `- ${after[0].n} scheduled message(s) due after that date use wallet credits;` : "- messages use wallet credits as usual;",
      "- email sign-in stops, and new subscriptions or email reminders need Pro again.",
      "",
      `Renew or check your plan: ${appUrl()}/pro`,
    ].join("\n");
    try {
      if (provider && p.email && p.verified) {
        await provider.send({ to: p.email, subject: title, text, html: textToHtml(text, { href: `${appUrl()}/pro`, label: "Open Pro" }), idempotencyKey: key });
      }
      await sendPushToUser(p.user_id, { title: "Nabikaran Pro", body: `${title}. Tap to see what changes.`, url: "/pro", tag: "pro-end" }, db);
      sent++;
    } catch (e) {
      console.warn(`[pro-notice] ${(e as Error).message}`);
    }
  }
  return sent;
}

/**
 * Free plan: one app notification a month ("3 renewals due in the next 30
 * days") for accounts with a push device and something due, so free users
 * come back between renewals. Once per Nepal calendar month (user_notices
 * `monthly:<YYYY-MM>:<user>`), daytime only. Pro accounts get the email digest.
 */
export async function runFreeMonthlyPush(db: Db = getDb(), now: Date = new Date(), limit = 200): Promise<number> {
  const k = utcToKathmandu(now);
  if (k.hour < 9 || k.hour >= 19) return 0;
  const month = `${k.year}-${String(k.month).padStart(2, "0")}`;
  const { rows } = await db.query<{ id: string; locale: string; due: number }>(
    `select u.id, u.locale,
            (select count(*) from renewal_items i where i.owner_user_id = u.id and i.status = 'active' and i.expiry_at_utc >= $1::timestamptz and i.expiry_at_utc < $1::timestamptz + interval '30 days')::int as due
       from users u
      where u.status = 'active' and u.role = 'user' and not u.nudges_opt_out
        and exists (select 1 from push_subscriptions p where p.user_id = u.id)
        and not exists (select 1 from user_plans pl where pl.user_id = u.id and pl.status = 'active' and pl.starts_at <= $1 and pl.ends_at > $1)
        and not exists (select 1 from user_notices n where n.user_id = u.id and n.key = $2 || ':' || u.id)
      limit $3`,
    [now.toISOString(), `monthly:${month}`, limit],
  );
  let sent = 0;
  for (const u of rows) {
    if (u.due <= 0) continue;
    const key = `monthly:${month}:${u.id}`;
    const { rows: ins } = await db.query("insert into user_notices (key, user_id, created_at) values ($1, $2, $3) on conflict (key) do nothing returning key", [key, u.id, now.toISOString()]);
    if (!ins[0]) continue;
    const ne = u.locale?.startsWith("ne");
    const title = ne ? `यो महिना ${u.due} नवीकरण` : `${u.due} renewal${u.due === 1 ? "" : "s"} due this month`;
    const body = ne ? "अर्को ३० दिनमा म्याद सकिने रेकर्ड हेर्नुहोस् र समयमै नवीकरण गर्नुहोस्।" : "See what expires in the next 30 days and renew on time.";
    try {
      if ((await sendPushToUser(u.id, { title, body, url: "/renewals?filter=due", tag: "monthly" }, db)) > 0) sent++;
    } catch (e) {
      console.warn(`[monthly] ${(e as Error).message}`);
    }
  }
  return sent;
}
