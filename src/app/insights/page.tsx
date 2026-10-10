import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { isPro } from "@/lib/services/plans";
import { getInsights } from "@/lib/services/insights";
import { formatDate, localizeNumber } from "@/lib/i18n/format";
import { Icon } from "@/components/Icon";
import { ProBadge } from "@/components/Shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Insights" };

export default async function InsightsPage() {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login?next=/insights");
  if (!(await isPro(user.id))) redirect("/pro");
  const ins = await getInsights(user.id);
  const n = (v: number, cur?: string | null) => localizeNumber(Number(v.toFixed(cur && cur !== "NPR" ? 2 : 0)), prefs.lang);
  const empty = ins.totals.length === 0 && ins.deadlines30.length === 0 && ins.spentLast12.length === 0;
  return (
    <div className="stack">
      <div className="page-head"><h1><Icon name="chart" /> {t("ins.title")} <ProBadge small /></h1></div>
      <p className="muted" style={{ marginTop: -8 }}>{t("ins.intro")}</p>
      {empty && <div className="card"><p className="mb-0">{t("ins.noData")} <Link href="/subscriptions#add">{t("sub.addSub")} →</Link></p></div>}

      <div className="grid grid-3 pro-tiles">
        <div className="stat"><div className="label">{t("sub.monthly")}</div><div className="value" style={{ fontSize: 20 }}>{ins.totals.length ? ins.totals.map((x) => `${x.currency} ${n(x.monthly, x.currency)}`).join(" · ") : "—"}</div></div>
        <div className="stat"><div className="label">{t("sub.yearly")}</div><div className="value" style={{ fontSize: 20 }}>{ins.totals.length ? ins.totals.map((x) => `${x.currency} ${n(x.yearly, x.currency)}`).join(" · ") : "—"}</div></div>
        <div className="stat"><div className="label">{t("ins.next90")}</div><div className="value" style={{ fontSize: 20 }}>{ins.upcoming90Total.length ? ins.upcoming90Total.map((x) => `${x.currency} ${n(x.amount, x.currency)}`).join(" · ") : "—"}</div></div>
      </div>

      {ins.byMethod.length > 0 && (
        <section className="card">
          <h2>{t("ins.byMethod")}</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t("sub.payment")}</th><th className="num">{t("sub.count")}</th><th className="num">{t("sub.monthly")}</th><th className="num">{t("sub.yearly")}</th></tr></thead>
              <tbody>{ins.byMethod.map((m) => <tr key={`${m.method}-${m.currency}`}><td>{m.method}</td><td className="num">{n(m.count)}</td><td className="num">{m.currency} {n(m.monthly, m.currency)}</td><td className="num">{m.currency} {n(m.monthly * 12, m.currency)}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <h2>{t("pro.dash.cancelTitle")}</h2>
          {ins.cancelAlerts.length + ins.trialsEnding.length === 0 ? <p className="muted mb-0">{t("pro.dash.none")}</p> : (
            <div className="list">
              {[...ins.cancelAlerts, ...ins.trialsEnding].sort((a, b) => a.dueAt.localeCompare(b.dueAt)).map((d) => (
                <Link key={d.id} href={`/renewals/${d.linkedTo ?? d.id}`} className="list-item">
                  <span className="grow"><strong>{d.label}</strong>{d.category === "free_trial" && <> <span className="badge warn">{t("sub.trialBadge")}</span></>}<br /><span className="small muted">{d.category === "cancel_deadline" ? t("sub.cancelBy", { date: formatDate(d.dueAt, prefs) }) : formatDate(d.dueAt, prefs)}</span></span>
                </Link>
              ))}
            </div>
          )}
        </section>
        <section className="card">
          <h2>{t("pro.dash.upcoming")}</h2>
          {ins.deadlines30.length === 0 ? <p className="muted mb-0">{t("pro.dash.none")}</p> : (
            <div className="list">
              {ins.deadlines30.map((d) => (
                <Link key={d.id} href={`/renewals/${d.id}`} className="list-item">
                  <span className="grow"><strong>{d.label}</strong><br /><span className="small muted">{formatDate(d.dueAt, prefs)}</span></span>
                  {d.amount !== null && <span className="sub-amt">{d.currency} {n(d.amount, d.currency)}</span>}
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      {ins.spentLast12.length > 0 && (
        <section className="card">
          <h2>{t("ins.spent12")}</h2>
          <p className="mb-0">{ins.spentLast12.map((s) => `${s.currency} ${n(s.amount, s.currency)} (${n(s.renewals)})`).join(" · ")} · <Link href="/history">{t("nav.history")} →</Link></p>
        </section>
      )}
    </div>
  );
}
