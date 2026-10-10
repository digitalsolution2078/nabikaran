import Link from "next/link";
import { Icon } from "./Icon";
import { ProBadge } from "./Shell";
import { AllowCredits } from "./AllowCredits";
import { formatDate, localizeNumber } from "@/lib/i18n/format";
import type { Insights } from "@/lib/services/insights";
import type { PlanState } from "@/lib/services/plans";
import type { MessageKey } from "@/lib/i18n/dict";
import type { Prefs } from "@/lib/i18n/format";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Pro dashboard: deadlines, spending, cancellation alerts and included messages. Server component. */
export function ProOverview({ t, prefs, plan, ins, waiting, onboarding }: {
  t: T; prefs: Prefs; plan: PlanState; ins: Insights;
  waiting: { count: number; credits: number };
  onboarding: { email: boolean; subscription: boolean; document: boolean };
}) {
  const n = (v: number, d = 0) => localizeNumber(Number(v.toFixed(d)), prefs.lang);
  const sms = plan.allowances.find((a) => a.channel === "sms");
  const monthly = ins.totals.length ? ins.totals.map((x) => `${x.currency} ${n(x.monthly, x.currency === "NPR" ? 0 : 2)}`).join(" · ") : "—";
  const steps: Array<[boolean, MessageKey, string]> = [
    [onboarding.email, "pro.onboard.email", "/settings#email"],
    [onboarding.subscription, "pro.onboard.sub", "/subscriptions#add"],
    [onboarding.document, "pro.onboard.doc", "/renewals/new"],
  ];
  const showSetup = steps.some(([done]) => !done);
  return (
    <>
      <section className="card pro-hero">
        <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
          <span className="row" style={{ gap: 8 }}><ProBadge /> <strong>{t("pro.yourPlan")}</strong></span>
          {plan.endsAt && <Link href="/pro" className="small">{t("plan.until", { date: formatDate(plan.endsAt, prefs) })}</Link>}
        </div>
        <div className="grid grid-4 pro-tiles mt">
          <Link href="/insights" className="stat"><div className="label">{t("pro.dash.deadlines")}</div><div className="value">{n(ins.deadlines30.length)}</div></Link>
          <Link href="/insights" className="stat"><div className="label">{t("pro.dash.monthly")}</div><div className="value" style={{ fontSize: 18 }}>{monthly}</div></Link>
          <Link href="/subscriptions" className="stat"><div className="label">{t("pro.dash.cancel")}</div><div className="value">{n(ins.cancelAlerts.length + ins.trialsEnding.length)}</div></Link>
          <Link href="/pro" className="stat"><div className="label">{t("pro.dash.included")}</div><div className="value">{sms ? `${n(sms.left)}/${n(sms.granted)}` : "—"}</div></Link>
        </div>
      </section>

      {waiting.count > 0 && (
        <div className="alert pro" role="status">
          <Icon name="alert" />
          <span><strong>{t("pro.permission.title")}</strong><br />{t("pro.permission.body", { n: n(waiting.count), credits: n(waiting.credits) })} <AllowCredits label={t("pro.permission.allow")} /></span>
        </div>
      )}
      {plan.endsAt && plan.daysLeft <= 30 && !plan.queuedUntil && (
        <div className="alert pro"><Icon name="info" /> <span>{t("pro.expiry.body", { date: formatDate(plan.endsAt, prefs) })} <Link href="/pro">{t("pro.seePro")} →</Link></span></div>
      )}

      {(ins.cancelAlerts.length > 0 || ins.trialsEnding.length > 0) && (
        <section className="card">
          <h2>{t("pro.dash.cancelTitle")}</h2>
          <div className="list">
            {[...ins.cancelAlerts, ...ins.trialsEnding].sort((a, b) => a.dueAt.localeCompare(b.dueAt)).map((d) => (
              <Link key={d.id} href={`/renewals/${d.linkedTo ?? d.id}`} className="list-item">
                <span className="grow"><strong>{d.label}</strong>{d.category === "free_trial" && <> <span className="badge warn">{t("sub.trialBadge")}</span></>}<br />
                  <span className="small muted">{d.category === "cancel_deadline" ? t("sub.cancelBy", { date: formatDate(d.dueAt, prefs) }) : formatDate(d.dueAt, prefs)}</span></span>
                {d.amount !== null && <span className="sub-amt">{d.currency} {n(d.amount, 2)}</span>}
              </Link>
            ))}
          </div>
        </section>
      )}

      {showSetup && (
        <section className="card">
          <h2>{t("pro.onboard.title")}</h2>
          <ul className="checklist todo mb-0">
            {steps.map(([done, key, href]) => (
              <li key={key} className={done ? "done" : ""}><Icon name={done ? "check" : "plus"} size={16} /> {done ? <span>{t(key)}</span> : <Link href={href}>{t(key)}</Link>}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
