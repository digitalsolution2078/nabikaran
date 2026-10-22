import { getDb, type Db } from "../db";
import { env } from "../env";
import { getEmailProvider, textToHtml } from "../providers/email";
import { utcToKathmandu } from "../time";
import { sendPushToUser } from "./push";
import { getSetting } from "./settings";

/**
 * "Did you renew?" follow-ups after a one-time record's expiry date passes.
 * A free app notification (plus email when verified) at `days` after expiry
 * (default 3 and 30), and for vehicle tax / bluebook one more at `tax_days`
 * (default 80: Nepal's 90-day late window is nearly over, fines rise). Each
 * step goes once per record (user_notices), 10 am–7 pm Nepal time, never by
 * SMS, and stops as soon as the record is marked renewed, edited to a new
 * date, paused or deleted. Repeating records roll forward on their own and
 * are never followed up.
 */
const DAY = 86_400_000;
const appUrl = () => env.appUrl.replace(/\/$/, "");
const TAX = new Set(["vehicle_tax", "bluebook"]);

interface Due {
  id: string;
  user_id: string;
  label: string;
  category: string;
  locale: string;
  email: string | null;
  verified: boolean;
  expiry_at_utc: unknown;
}

/** Which follow-up (days after expiry) is due for a record that expired `ageDays` ago, if any. */
export function followupStage(ageDays: number, category: string, s: { days: number[]; tax_days: number }): number | null {
  const ladder = [...s.days, ...(TAX.has(category) ? [s.tax_days] : [])].sort((a, b) => b - a);
  return ladder.find((d) => ageDays >= d) ?? null;
}

const COPY = {
  en: (label: string, stage: number, tax: boolean) => ({
    title: `Did you renew ${label}?`,
    body: tax && stage >= 60
      ? `Its date passed ${stage} days ago. Vehicle tax late fines rise after 90 days. Mark it renewed or update the date.`
      : `Its date passed ${stage} days ago. Mark it renewed or update the date so your records stay right.`,
    cta: "Open the record",
  }),
  ne: (label: string, stage: number, tax: boolean) => ({
    title: `${label} नवीकरण गर्नुभयो?`,
    body: tax && stage >= 60
      ? `म्याद सकिएको ${stage} दिन भयो। सवारी करमा ९० दिनपछि जरिवाना बढ्छ। नवीकरण गरिसकेको भए चिन्ह लगाउनुहोस् वा नयाँ मिति राख्नुहोस्।`
      : `म्याद सकिएको ${stage} दिन भयो। नवीकरण गरिसकेको भए चिन्ह लगाउनुहोस् वा नयाँ मिति राख्नुहोस्, रेकर्ड सही रहन्छ।`,
    cta: "रेकर्ड खोल्नुहोस्",
  }),
};

/** Send due follow-ups. Returns how many records were followed up. Run from the reconciler. */
export async function runRenewalFollowups(db: Db = getDb(), now: Date = new Date(), limit = 200): Promise<number> {
  const s = await getSetting("followups", db);
  if (!s.enabled) return 0;
  const hour = utcToKathmandu(now).hour;
  if (hour < 10 || hour >= 19) return 0;
  const minDays = Math.min(...s.days, s.tax_days);
  const maxDays = Math.max(...s.days, s.tax_days) + 14;
  const { rows } = await db.query<Due>(
    `select i.id, i.owner_user_id as user_id, i.label, i.category, u.locale, u.email, (u.email_verified_at is not null) as verified, i.expiry_at_utc
       from renewal_items i join users u on u.id = i.owner_user_id
      where i.status = 'active' and not i.repeat_yearly and i.repeat_months is null and i.linked_to is null and i.client_id is null
        and u.status = 'active' and not u.nudges_opt_out
        and i.expiry_at_utc <= $1::timestamptz - make_interval(days => $2)
        and i.expiry_at_utc > $1::timestamptz - make_interval(days => $3)
        -- not renewed since the date passed, and not edited to a newer date (expiry would then be in the future)
        and not exists (select 1 from renewal_history h where h.renewal_id = i.id and h.created_at >= i.expiry_at_utc)
      order by i.expiry_at_utc limit $4`,
    [now.toISOString(), minDays, maxDays, limit],
  );
  if (!rows.length) return 0;
  const email = await getEmailProvider(db);
  let sent = 0;
  for (const r of rows) {
    const expiry = r.expiry_at_utc instanceof Date ? r.expiry_at_utc : new Date(String(r.expiry_at_utc));
    const stage = followupStage((now.getTime() - expiry.getTime()) / DAY, r.category, s);
    if (stage === null) continue;
    const key = `followup:${stage}:${r.id}`;
    const { rows: ins } = await db.query("insert into user_notices (key, user_id, created_at) values ($1, $2, $3) on conflict (key) do nothing returning key", [key, r.user_id, now.toISOString()]);
    if (!ins[0]) continue;
    const c = (r.locale?.startsWith("ne") ? COPY.ne : COPY.en)(r.label, stage, TAX.has(r.category));
    const url = `/renewals/${r.id}`;
    const channels: string[] = [];
    try {
      if ((await sendPushToUser(r.user_id, { title: c.title, body: c.body, url, tag: "followup" }, db)) > 0) channels.push("push");
    } catch (e) {
      console.warn(`[followup] push: ${(e as Error).message}`);
    }
    if (email && r.email && r.verified) {
      try {
        const text = `${c.body}\n\n${c.cta}: ${appUrl()}${url}`;
        if ((await email.send({ to: r.email, subject: `Nabikaran: ${c.title}`, text, html: textToHtml(text, { href: `${appUrl()}${url}`, label: c.cta }), idempotencyKey: key })).kind === "accepted") channels.push("email");
      } catch (e) {
        console.warn(`[followup] email: ${(e as Error).message}`);
      }
    }
    await db.query("insert into audit_events (actor_via, action, target_type, target_id, json_detail_redacted) values ('worker','renewal.followup','renewal',$1,$2)", [r.id, JSON.stringify({ stage, channels })]);
    if (channels.length) sent++;
  }
  return sent;
}
