import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { getLockState } from "@/lib/core/account-lock";
import { getCustomerSummary, type CustomerSummary, type MessageRow } from "@/lib/services/customer-summary";
import { StatusBadge } from "@/components/StatusBadge";
import { ChannelBadge } from "@/components/ChannelBadge";
import { Icon, iconForCategory } from "@/components/Icon";
import { formatDate, formatDateTime, daysUntil, localizeNumber, offsetLabel } from "@/lib/i18n/format";
import type { MessageKey } from "@/lib/i18n/dict";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard" };

/**
 * Customer dashboard. Data comes from one summary service; if it fails the
 * page still renders (header, quick actions, an inline error) instead of a
 * server error, and the failure is logged with the user id for operators.
 */
export default async function Dashboard() {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login");
  const [summaryR, lockR] = await Promise.allSettled([getCustomerSummary(user.id), getLockState(user.id)]);
  if (summaryR.status === "rejected") console.error(`[dashboard] summary failed for user ${user.id}:`, summaryR.reason);
  if (lockR.status === "rejected") console.error(`[dashboard] lock state failed for user ${user.id}:`, lockR.reason);
  const s = summaryR.status === "fulfilled" ? summaryR.value : null;
  const lock = lockR.status === "fulfilled" ? lockR.value : null;
  const n = (v: number) => localizeNumber(v, prefs.lang);
  const daysText = (d: number) => (d < 0 ? t("dash.overdue") : d === 0 ? t("dash.today") : d === 1 ? t("dash.dayLeft") : t("dash.daysLeft", { n: n(d) }));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{t("dash.greeting")}{user.displayName ? `, ${user.displayName}` : ""}</h1>
          <p>{t("brand.tagline")}</p>
        </div>
      </div>

      <nav className="quick-actions" aria-label={t("dash.quick")}>
        <Link href="/renewals/new" className="qa qa-primary"><Icon name="plus" /> <span>{t("dash.addReminder")}</span></Link>
        <Link href={s && s.wallet.available < 0 ? `/wallet?amount=${Math.max(20, -s.wallet.available)}` : "/wallet"} className="qa"><Icon name="wallet" /> <span>{t("dash.topUp")}</span></Link>
        <Link href="/messages" className="qa"><Icon name="message" /> <span>{t("dash.viewPending")}</span></Link>
        <Link href="/renewals" className="qa"><Icon name="list" /> <span>{t("dash.viewAll")}</span></Link>
      </nav>

      {lock?.locked && (
        <div className="alert warn"><Icon name="alert" /> <span><strong>{t("lock.title")}</strong> — {t("lock.body", { balance: n(lock.available), min: n(lock.minBalance) })} <Link href={`/wallet?amount=${Math.max(20, -lock.available)}`}>{t("lock.cta")} →</Link></span></div>
      )}
      {!lock?.locked && s && s.wallet.available < 0 && (
        <div className="alert info"><Icon name="info" /> <span>{t("wallet.negative")} <Link href="/wallet">{t("dash.topUp")} →</Link></span></div>
      )}
      {s && s.counts.awaitingCredits > 0 && (
        <div className="alert warn"><Icon name="alert" /> <span>{t("dash.awaitingCredits")} <Link href="/wallet">{t("lock.cta")} →</Link></span></div>
      )}

      {!s ? (
        <div className="alert bad" role="alert"><Icon name="alert" /> <span>{t("dash.sectionError")}</span></div>
      ) : (
        <>
          <div className="stat-grid">
            <Stat href="/renewals?filter=expired" icon="alert" tone={s.counts.expired > 0 ? "bad" : ""} label={t("dash.expired")} value={n(s.counts.expired)} />
            <Stat href="/renewals?filter=due" icon="clock" tone={s.counts.dueSoon > 0 ? "warn" : ""} label={t("dash.dueSoon")} value={n(s.counts.dueSoon)} />
            <Stat href="/messages" icon="calendar" label={t("dash.upcomingMsgs")} value={n(s.counts.upcomingMessages)} />
            <Stat href="/renewals?filter=awaiting" icon="lock" tone={s.counts.awaitingCredits > 0 ? "warn" : ""} label={t("dash.awaiting")} value={n(s.counts.awaitingCredits)} />
            <Stat href="/wallet" icon="wallet" tone={s.wallet.available < 0 ? "bad" : "brand"} label={t("dash.wallet")} value={n(s.wallet.available)} sub={`${n(s.wallet.reserved)} ${t("dash.reservedSub")}`} />
            <NextStat next={s.next} t={t} prefs={prefs} />
          </div>

          <div className="grid grid-2">
            <section className="card">
              <div className="card-head"><h2>{t("dash.expiringSoon")}</h2><Link href="/renewals" className="small">{t("wallet.viewAll")}</Link></div>
              {s.expiringSoon.length === 0 ? (
                <div className="empty">
                  <div className="icon-wrap"><Icon name="file" size={26} /></div>
                  <p>{t("dash.noneUpcoming")}</p>
                  <Link href="/renewals/new" className="btn btn-primary btn-sm">{t("dash.addFirst")}</Link>
                </div>
              ) : (
                <div className="list">
                  {s.expiringSoon.map((r) => {
                    const d = daysUntil(r.expiryAt);
                    return (
                      <Link key={r.id} href={`/renewals/${r.id}`} className="list-item" style={{ color: "inherit", textDecoration: "none" }}>
                        <span className="avatar-icon"><Icon name={iconForCategory(r.category)} /></span>
                        <span className="grow">
                          <span className="title" style={{ display: "block" }}>{r.label}</span>
                          <span className="meta">{formatDate(r.expiryAt, prefs)} · {formatDate(r.expiryAt, { ...prefs, date: prefs.date === "BS" ? "AD" : "BS" })}</span>
                        </span>
                        <span className={`days-pill ${d < 0 ? "past" : d <= 30 ? "soon" : ""}`}>{daysText(d)}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="card">
              <div className="card-head"><h2>{t("dash.upcoming")}</h2><Link href="/messages" className="small">{t("wallet.viewAll")}</Link></div>
              <MessageList rows={s.upcoming.slice(0, 6)} empty={t("dash.noneUpcoming")} t={t} prefs={prefs} />
            </section>
          </div>

          <section className="card">
            <div className="card-head"><h2>{t("dash.recent")}</h2><Link href="/messages?tab=history" className="small">{t("wallet.viewAll")}</Link></div>
            <MessageList rows={s.recent.slice(0, 5)} empty={t("dash.noneRecent")} t={t} prefs={prefs} />
          </section>
        </>
      )}
    </div>
  );
}

type T = (k: MessageKey, v?: Record<string, string | number>) => string;
type P = { lang: "ne" | "en"; date: "AD" | "BS" };

function Stat({ href, icon, label, value, sub, tone = "" }: { href: string; icon: Parameters<typeof Icon>[0]["name"]; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Link href={href} className={`stat stat-link ${tone ? `stat-${tone}` : ""}`}>
      <div className="label"><span className="icon-chip"><Icon name={icon} size={16} /></span>{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </Link>
  );
}

function NextStat({ next, t, prefs }: { next: CustomerSummary["next"]; t: T; prefs: P }) {
  return (
    <Link href={next ? `/renewals/${next.renewalId}` : "/renewals/new"} className="stat stat-link">
      <div className="label"><span className="icon-chip"><Icon name="bell" size={16} /></span>{t("dash.next")}</div>
      {next ? (
        <>
          <div className="value value-sm">{formatDateTime(next.dueAt, prefs)}</div>
          <div className="sub"><ChannelBadge channel={next.channel} /> {next.label}</div>
        </>
      ) : (
        <div className="value value-sm muted">{t("dash.nextNone")}</div>
      )}
    </Link>
  );
}

function MessageList({ rows, empty, t, prefs }: { rows: MessageRow[]; empty: string; t: T; prefs: P }) {
  if (rows.length === 0) return <p className="muted mb-0">{empty}</p>;
  return (
    <div className="list">
      {rows.map((m) => (
        <Link key={m.id} href={`/renewals/${m.renewalId}`} className="list-item" style={{ color: "inherit", textDecoration: "none" }}>
          <span className="avatar-icon"><Icon name={m.channel === "whatsapp" ? "message" : "bell"} /></span>
          <span className="grow">
            <span className="title" style={{ display: "block" }}>{m.label}</span>
            <span className="meta"><ChannelBadge channel={m.channel} /> {formatDateTime(m.dueAt, prefs)} · {offsetLabel(m.offsetMinutes, prefs.lang)}</span>
          </span>
          <StatusBadge status={m.status} />
        </Link>
      ))}
    </div>
  );
}
