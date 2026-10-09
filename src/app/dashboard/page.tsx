import Link from "next/link";
import { getLockState } from "@/lib/core/account-lock";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { webPrincipal } from "@/lib/core/principal";
import { listReminders, listJobsForUser } from "@/lib/core/reminders";
import { getWallet } from "@/lib/core/wallet";
import { StatusBadge } from "@/components/StatusBadge";
import { Icon, iconForCategory } from "@/components/Icon";
import { formatDate, formatDateTime, daysUntil, localizeNumber, offsetLabel } from "@/lib/i18n/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard" };

export default async function Dashboard() {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login");
  const p = webPrincipal(user);
  const [{ reminders }, wallet, jobs, lock] = await Promise.all([listReminders(p, { status: "active", limit: 50 }), getWallet(p), listJobsForUser(p, 100), getLockState(user.id)]);
  const upcoming = jobs.filter((j) => ["scheduled", "awaiting_credits", "planned"].includes(j.status)).sort((a, b) => a.due_at_utc.localeCompare(b.due_at_utc)).slice(0, 6);
  const sent = jobs.filter((j) => ["submitted", "delivered", "failed", "unknown"].includes(j.status));
  const sentCount = jobs.filter((j) => j.status === "submitted" || j.status === "delivered").length;
  const expiring = [...reminders].sort((a, b) => a.expiry.utc.localeCompare(b.expiry.utc)).slice(0, 5);
  const n = (v: number) => localizeNumber(v, prefs.lang);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{t("dash.greeting")}{user.displayName ? `, ${user.displayName}` : ""} 👋</h1>
          <p>{t("brand.tagline")}</p>
        </div>
        <div className="row">
          <Link href="/wallet" className="btn btn-secondary"><Icon name="wallet" /> {t("dash.topUp")}</Link>
          <Link href="/renewals/new" className="btn btn-primary"><Icon name="plus" /> {t("dash.addReminder")}</Link>
        </div>
      </div>

      <div className="grid grid-4">
        <div className="stat stat-hero">
          <div className="label"><span className="icon-chip"><Icon name="wallet" size={16} /></span>{t("dash.available")}</div>
          <div className="value">{n(wallet.available)}</div>
          <div className="sub">{t("wallet.noExpiry")}</div>
        </div>
        <div className="stat">
          <div className="label"><span className="icon-chip yellow"><Icon name="lock" size={16} /></span>{t("dash.reserved")}</div>
          <div className="value">{n(wallet.reserved)}</div>
        </div>
        <div className="stat">
          <div className="label"><span className="icon-chip"><Icon name="bell" size={16} /></span>{t("dash.active")}</div>
          <div className="value">{n(reminders.length)}</div>
        </div>
        <div className="stat">
          <div className="label"><span className="icon-chip orange"><Icon name="message" size={16} /></span>{t("dash.sent")}</div>
          <div className="value">{n(sentCount)}</div>
        </div>
      </div>

      {lock.locked ? (
        <div className="alert warn"><Icon name="alert" /> <span><strong>{t("lock.title")}</strong> — {t("lock.body", { balance: n(lock.available), min: n(lock.minBalance) })} <Link href={`/wallet?amount=${Math.max(20, -lock.available)}`}>{t("lock.cta")} →</Link></span></div>
      ) : wallet.available < 0 ? (
        <div className="alert info"><Icon name="info" /> <span>{t("wallet.negative")} <Link href="/wallet">{t("dash.topUp")} →</Link></span></div>
      ) : null}
      {jobs.some((j) => j.status === "awaiting_credits") && (
        <div className="alert warn"><Icon name="alert" /> <span>{t("dash.awaitingCredits")} <Link href="/wallet">{t("dash.topUp")} →</Link></span></div>
      )}

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head"><h2>{t("dash.expiringSoon")}</h2><Link href="/renewals" className="small">{t("wallet.viewAll")}</Link></div>
          {expiring.length === 0 ? (
            <div className="empty">
              <div className="icon-wrap"><Icon name="file" size={26} /></div>
              <p>{t("dash.noneUpcoming")}</p>
              <Link href="/renewals/new" className="btn btn-primary btn-sm">{t("dash.addFirst")}</Link>
            </div>
          ) : (
            <div className="list">
              {expiring.map((r) => {
                const d = daysUntil(r.expiry.utc);
                return (
                  <Link key={r.id} href={`/renewals/${r.id}`} className="list-item" style={{ color: "inherit", textDecoration: "none" }}>
                    <span className="avatar-icon"><Icon name={iconForCategory(r.category)} /></span>
                    <span className="grow">
                      <span className="title" style={{ display: "block" }}>{r.label}</span>
                      <span className="meta">{formatDate(r.expiry.utc, prefs)}</span>
                    </span>
                    <span className={`days-pill ${d < 0 ? "past" : d <= 30 ? "soon" : ""}`}>{d < 0 ? t("dash.overdue") : d === 0 ? t("dash.today") : t("dash.daysLeft", { n: n(d) })}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head"><h2>{t("dash.upcoming")}</h2></div>
          {upcoming.length === 0 ? (
            <p className="muted">{t("dash.noneUpcoming")}</p>
          ) : (
            <div className="list">
              {upcoming.map((j) => (
                <div key={j.id} className="list-item">
                  <span className="avatar-icon"><Icon name="clock" /></span>
                  <span className="grow">
                    <span className="title" style={{ display: "block" }}>{j.label}</span>
                    <span className="meta">{formatDateTime(j.due_at_utc, prefs)} · {offsetLabel(j.offset_minutes ?? 0, prefs.lang)}</span>
                  </span>
                  <StatusBadge status={j.status} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>{t("dash.recentSms")}</h2><Link href="/wallet/history" className="small">{t("wallet.viewAll")}</Link></div>
        {sent.length === 0 ? (
          <p className="muted mb-0">{t("dash.noneSms")}</p>
        ) : (
          <div className="list">
            {sent.slice(0, 5).map((j) => (
              <div key={j.id} className="list-item">
                <span className="avatar-icon"><Icon name="message" /></span>
                <span className="grow"><span className="title" style={{ display: "block" }}>{j.label}</span><span className="meta">{formatDateTime(j.due_at_utc, prefs)}</span></span>
                <StatusBadge status={j.status} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
