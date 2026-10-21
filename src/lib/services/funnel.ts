import { getDb, type Db } from "../db";

/**
 * Admin → Dashboard: the sign-up funnel, derived from the tables we already
 * keep (no third-party analytics): accounts created → first record → first
 * top-up (real money) → Pro. Also where sign-ups came from (users.signup_source,
 * captured from utm_source / a referral code on the first visit).
 */
export interface FunnelReport {
  days: number;
  signups: number;
  firstRecord: number;
  firstTopup: number;
  pro: number;
  /** Sign-ups in the window that have no record yet (nudge targets). */
  noRecord: number;
  sources: Array<{ source: string; signups: number; withRecord: number }>;
}

export async function funnelReport(days = 30, db: Db = getDb()): Promise<FunnelReport> {
  const span = Math.min(366, Math.max(1, Math.floor(days)));
  const { rows } = await db.query<{ signups: number; first_record: number; first_topup: number; pro: number }>(
    `with u as (select id from users where role = 'user' and created_at > now() - make_interval(days => $1))
     select (select count(*) from u)::int as signups,
            (select count(*) from u where exists (select 1 from renewal_items i where i.owner_user_id = u.id))::int as first_record,
            (select count(*) from u where exists (select 1 from wallet_ledger l where l.user_id = u.id and l.type = 'topup'))::int as first_topup,
            (select count(*) from u where exists (select 1 from user_plans p where p.user_id = u.id and p.status = 'active'))::int as pro`,
    [span],
  );
  const { rows: src } = await db.query<{ source: string; signups: number; with_record: number }>(
    `select coalesce(nullif(signup_source, ''), 'direct') as source, count(*)::int as signups,
            count(*) filter (where exists (select 1 from renewal_items i where i.owner_user_id = u.id))::int as with_record
       from users u where role = 'user' and created_at > now() - make_interval(days => $1)
      group by 1 order by 2 desc limit 8`,
    [span],
  );
  const r = rows[0];
  return {
    days: span,
    signups: r.signups,
    firstRecord: r.first_record,
    firstTopup: r.first_topup,
    pro: r.pro,
    noRecord: r.signups - r.first_record,
    sources: src.map((x) => ({ source: x.source, signups: x.signups, withRecord: x.with_record })),
  };
}

/** Cookie set on the first visit with ?utm_source= or ?ref= (see SourceCapture); read once at sign-up. */
export const SOURCE_COOKIE = "nb_src";

/** A sign-up source string from utm_source / ref, kept short and plain. */
export function cleanSource(raw: string | null | undefined): string | null {
  const s = decodeURIComponent(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_./-]/g, "").slice(0, 40);
  return s || null;
}
