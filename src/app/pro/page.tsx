import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { getPlanState, getProPrefs } from "@/lib/services/plans";
import { ProPrefs } from "@/components/ProPrefs";
import { ProBadge } from "@/components/Shell";
import { readWallet } from "@/lib/core/wallet";
import { formatDate, localizeNumber } from "@/lib/i18n/format";
import { ProActions } from "@/components/ProActions";
import { ChannelBadge } from "@/components/ChannelBadge";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pro" };

export default async function ProPage() {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login?next=/pro");
  const [st, wallet, proPrefs] = await Promise.all([getPlanState(user.id), readWallet(user.id), getProPrefs(user.id)]);
  const o = st.offer;
  const n = (x: number) => localizeNumber(x, prefs.lang);
  if (st.tier === "basic" && !o.enabled) {
    return <div className="stack"><h1>{t("pro.title")}</h1><div className="card"><p className="mb-0">{t("pro.comingSoon")}</p></div></div>;
  }
  const benefits = [
    t("pro.benefit.subs"),
    t("pro.benefit.messages", { sms: n(o.allowance_sms), wa: n(o.allowance_whatsapp), email: n(o.allowance_email) }),
    t("pro.benefit.email"),
    t("pro.benefit.monthly"),
    t("pro.benefit.all"),
  ];
  return (
    <div className="stack">
      <div className="page-head"><h1>{t("pro.title")} <ProBadge /></h1></div>
      <p className="lead" style={{ marginTop: -8 }}>{t("pro.tagline")}</p>

      {st.tier === "pro" && (
        <section className="card pro-status pro-hero">
          <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
            <h2 style={{ margin: 0 }}>{st.kind === "trial" ? t("pro.trialActive") : st.kind === "grant" ? t("pro.granted") : t("pro.active")}</h2>
            <span className="badge ok">{t("pro.endsOn", { date: formatDate(st.endsAt!, prefs), n: n(st.daysLeft) })}</span>
          </div>
          {st.queuedUntil && <p className="hint">{t("pro.nextYearQueued", { date: formatDate(st.queuedUntil, prefs) })}</p>}
          {st.kind === "trial" ? (
            <p className="muted">{t("pro.trialNoAllowance", { sms: n(o.allowance_sms), wa: n(o.allowance_whatsapp), email: n(o.allowance_email) })}</p>
          ) : (
            <>
              <h3 className="mt">{t("pro.allowance")}</h3>
              <div className="grid grid-3">
                {st.allowances.map((a) => (
                  <div className="stat" key={a.channel}>
                    <div className="label"><ChannelBadge channel={a.channel} /></div>
                    <div className="value">{n(a.left)}</div>
                    <div className="sub">{t("pro.left", { left: n(a.left), total: n(a.granted) })}</div>
                    <div className="meter" aria-hidden><span style={{ width: `${a.granted ? Math.round(((a.used + a.reserved) / a.granted) * 100) : 0}%` }} /></div>
                  </div>
                ))}
              </div>
              <p className="hint">{t("pro.allowanceHint")} {t("plan.credits")}: <strong>{n(wallet.available)}</strong></p>
            </>
          )}
          <div className="row mt" style={{ gap: 8, flexWrap: "wrap" }}>
            <Link href="/subscriptions" className="btn btn-primary"><Icon name="repeat" size={16} /> {t("pro.manageSubs")}</Link>
            <Link href="/settings#email" className="btn btn-secondary">{t("pro.emailSettings")}</Link>
          </div>
        </section>
      )}

      {st.tier === "pro" && st.kind !== "trial" && <ProPrefs initial={proPrefs} />}
      {/* The offer (trial / buy / add a year) shows for Basic, trial, and in the last 30 days of a plan. */}
      {(st.tier === "basic" || st.kind === "trial" || (st.daysLeft <= 30 && !st.queuedUntil)) && (
      <section className="card pro-offer">
        {st.tier === "basic" && <p style={{ marginTop: 0 }}>{t("pro.upgradeText")}</p>}
        <div className="pro-price"><strong>{t("pro.price", { n: n(o.price_npr) })}</strong></div>
        <ul className="checklist">
          {benefits.map((b) => <li key={b}><Icon name="check" size={16} /> <span>{b}</span></li>)}
        </ul>
        {o.enabled && (
          <ProActions
            price={o.price_npr}
            available={wallet.available}
            canTrial={st.tier === "basic" && o.trial_enabled && !st.trialUsed}
            trialDays={o.trial_days}
            trialUsed={st.trialUsed}
            isPro={st.tier === "pro"}
            isTrial={st.kind === "trial"}
          />
        )}
        <p className="hint mt mb-0"><Icon name="info" size={12} /> {t("pro.noRefund")}</p>
      </section>
      )}
    </div>
  );
}
