import Link from "next/link";
import type { Metadata } from "next";
import { getRequestContext } from "@/lib/i18n/server";
import { getSetting } from "@/lib/services/settings";
import { getActivePricing } from "@/lib/core/wallet";
import { getPlanState } from "@/lib/services/plans";
import { ProBadge } from "@/components/Shell";
import { Icon } from "@/components/Icon";
import { localizeNumber } from "@/lib/i18n/format";
import type { MessageKey } from "@/lib/i18n/dict";
import { listBonusTiers } from "@/lib/services/pricing";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Pricing — Basic and Pro",
  description: "Nabikaran pricing: free Basic plan with pay-per-message SMS and WhatsApp reminders, or Nabikaran Pro for NPR 1,000 a year with included messages, a subscription manager and Google Calendar sync.",
  alternates: { canonical: "/pricing" },
};

const price = async (ch: "sms" | "whatsapp" | "email") => (await getActivePricing(undefined, ch).catch(() => null))?.creditsPerUnit ?? null;

/** Public pricing page. All numbers come from the live admin settings and pricing versions. */
export default async function PricingPage() {
  const { user, t, prefs } = await getRequestContext();
  const n = (v: number) => localizeNumber(v, prefs.lang);
  const [pro, topup, codes, sms, wa, email, plan, tiers] = await Promise.all([
    getSetting("pro"), getSetting("topup"), getSetting("codes"), price("sms"), price("whatsapp"), price("email"),
    user ? getPlanState(user.id) : Promise.resolve(null),
    listBonusTiers().catch(() => []),
  ]);
  const isPro = plan?.tier === "pro";
  const trialOpen = pro.enabled && pro.trial_enabled && !(plan?.trialUsed ?? false);
  const basicCta = user ? { href: "/dashboard", label: t("nav.dashboard") } : { href: "/login", label: t("price.startFree") };
  const proCta = !pro.enabled ? null
    : isPro ? { href: "/pro", label: t("price.managePro") }
    : user ? { href: "/pro", label: trialOpen ? t("price.tryPro", { days: n(pro.trial_days) }) : t("price.getPro") }
    : { href: "/login?next=/pro", label: trialOpen ? t("price.tryPro", { days: n(pro.trial_days) }) : t("price.getPro") };

  // [label, basic, pro] — true = included, string = detail, false = not included
  const rows: Array<[MessageKey, boolean | string, boolean | string]> = [
    ["price.row.reminders", true, true],
    ["price.row.push", true, true],
    ["price.row.dates", true, true],
    ["price.row.repeat", true, true],
    ["price.row.ai", true, true],
    ["price.row.included", false, t("price.includedShort", { sms: n(pro.allowance_sms), wa: n(pro.allowance_whatsapp), email: n(pro.allowance_email) })],
    ["price.row.subs", false, true],
    ["price.row.alerts", false, true],
    ["price.row.insights", false, true],
    ["price.row.email", false, true],
    ["price.row.calendar", false, true],
    ["price.row.aiSubs", false, true],
  ];
  const cell = (v: boolean | string) => (v === true ? <Icon name="check" size={18} /> : v === false ? <span className="muted">—</span> : <span className="small">{v}</span>);

  return (
    <div className="stack">
      <section className="hero-band" style={{ textAlign: "center" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <h1>{t("price.title")}</h1>
          <p className="lead">{t("price.lead")}</p>
        </div>
      </section>

      <div className="grid grid-2" style={{ alignItems: "stretch" }}>
        <section className="card" aria-labelledby="plan-basic">
          <h2 id="plan-basic">Basic</h2>
          <p className="muted">{t("price.basicTag")}</p>
          <div className="price-big">{t("price.free")}</div>
          <p className="small muted">{t("price.basicSub")}</p>
          <ul className="check-list">
            <li>{t("price.b1")}</li><li>{t("price.b2")}</li><li>{t("price.b3")}</li><li>{t("price.b4")}</li>
          </ul>
          <Link href={basicCta.href} className="btn btn-secondary btn-block">{basicCta.label}</Link>
        </section>

        <section className="card pro-hero" aria-labelledby="plan-pro" style={{ position: "relative" }}>
          <h2 id="plan-pro">Pro <ProBadge /></h2>
          <p className="muted">{t("price.proTag")}</p>
          {pro.enabled ? (
            <>
              <div className="price-big">{t("common.npr")} {n(pro.price_npr)} <span className="small muted">/ {pro.duration_days >= 360 ? t("price.year") : t("price.days", { n: n(pro.duration_days) })}</span></div>
              <p className="small muted">{t("price.proSub", { month: n(Math.round(pro.price_npr / Math.max(1, pro.duration_days / 30.4))) })}</p>
              <ul className="check-list">
                <li><strong>{t("price.p1", { sms: n(pro.allowance_sms), wa: n(pro.allowance_whatsapp), email: n(pro.allowance_email) })}</strong></li>
                <li>{t("price.p2")}</li><li>{t("price.p3")}</li><li>{t("price.p4")}</li><li>{t("price.p5")}</li>
              </ul>
              {trialOpen && <p className="hint">{t("price.trialNote", { days: n(pro.trial_days) })}</p>}
              {proCta && <Link href={proCta.href} className="btn btn-primary btn-block">{proCta.label}</Link>}
            </>
          ) : <p className="alert info">{t("pro.comingSoon")}</p>}
        </section>
      </div>

      <section className="card">
        <h2>{t("price.compare")}</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t("price.feature")}</th><th style={{ textAlign: "center" }}>Basic</th><th style={{ textAlign: "center" }}>Pro</th></tr></thead>
            <tbody>
              {rows.map(([k, b, p]) => <tr key={k}><td>{t(k)}</td><td style={{ textAlign: "center" }}>{cell(b)}</td><td style={{ textAlign: "center" }}>{cell(p)}</td></tr>)}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <h2>{t("price.perMessage")}</h2>
          <p className="muted small">{t("price.perMessageIntro")}</p>
          <dl className="kv">
            {sms !== null && <><dt>SMS</dt><dd>{t("price.perSms", { n: n(sms) })}</dd></>}
            {wa !== null && <><dt>WhatsApp</dt><dd>{wa === 1 ? t("price.perMsgOne") : t("price.perMsg", { n: n(wa) })}</dd></>}
            {email !== null && <><dt>Email (Pro)</dt><dd>{email === 1 ? t("price.perMsgOne") : t("price.perMsg", { n: n(email) })}</dd></>}
            <dt>{t("price.pushLabel")}</dt><dd>{t("price.freeWord")}</dd>
          </dl>
          <p className="hint mb-0">{t("price.segmentNote")}</p>
        </section>
        <section className="card">
          <h2>{t("price.howPay")}</h2>
          <ul className="check-list">
            <li>{t("price.pay1", { min: n(topup.min_npr), max: n(topup.max_npr) })}</li>
            <li>{t("price.pay2")}</li>
            <li>{t("price.pay3")}</li>
          </ul>
          {tiers.length > 0 && (
            <div className="bonus-box">
              <strong><Icon name="gift" size={16} /> {t("price.bonusTitle")}</strong>
              <p className="small muted mb-0">{t("price.bonusText")}</p>
              <div className="chips mt">
                {tiers.map((tr) => <span key={tr.minNpr} className="chip">{t("wallet.bonusRow", { min: n(tr.minNpr), pct: n(tr.percent) })}</span>)}
              </div>
            </div>
          )}
          {codes.gifts_enabled && (
            <Link href="/gift" className="row" style={{ gap: 10, color: "inherit", textDecoration: "none" }}>
              <span className="avatar-icon"><Icon name="gift" /></span>
              <span><strong>{t("gift.landingCta")}</strong><br /><span className="small muted">{t("price.giftLine")}</span></span>
            </Link>
          )}
        </section>
      </div>

      <section className="section" style={{ maxWidth: 760, margin: "0 auto", width: "100%" }}>
        <div className="section-title"><h2>{t("landing.faq")}</h2></div>
        {(["1", "2", "3", "4", "5", "6"] as const).map((i) => (
          <details className="faq" key={i}>
            <summary>{t(`price.q${i}` as MessageKey)}</summary>
            <p>{t(`price.a${i}` as MessageKey, { price: n(pro.price_npr), days: n(pro.trial_days) })}</p>
          </details>
        ))}
      </section>
    </div>
  );
}
