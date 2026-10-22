import Link from "next/link";
import { getRequestContext } from "@/lib/i18n/server";
import { Icon, type IconName } from "@/components/Icon";
import { RotatingWords } from "@/components/motion/RotatingWords";
import { listDocTemplates } from "@/lib/services/admin-console";
import { listSeoPages } from "@/lib/services/seo";
import { formatDate, localizeNumber } from "@/lib/i18n/format";
import type { MessageKey } from "@/lib/i18n/dict";

const DOCS: { icon: IconName; key: MessageKey }[] = [
  { icon: "car", key: "landing.doc1" }, { icon: "file", key: "landing.doc2" }, { icon: "passport", key: "landing.doc3" },
  { icon: "shield", key: "landing.doc4" }, { icon: "umbrella", key: "landing.doc5" }, { icon: "briefcase", key: "landing.doc6" },
  { icon: "receipt", key: "landing.doc7" }, { icon: "home", key: "landing.doc8" }, { icon: "globe", key: "landing.doc9" },
  { icon: "repeat", key: "landing.doc10" }, { icon: "gift", key: "landing.doc11" }, { icon: "wallet", key: "landing.doc12" },
];

const SAMPLE_DATE = "2026-11-02T06:00:00.000Z";

export const metadata = { alternates: { canonical: "/" } };

const ORG_JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", name: "Nabikaran", url: "https://nabikaran.org", logo: "https://nabikaran.org/brand/nabikaran-logo.png", areaServed: "NP" },
    {
      "@type": "SoftwareApplication", name: "Nabikaran", applicationCategory: "UtilitiesApplication", operatingSystem: "Web, Android, iOS",
      description: "Renewal reminders for Nepal: Bluebook, driving licence, insurance, passport, tax, subscriptions. App, SMS and WhatsApp reminders in BS and AD dates.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "NPR" }, url: "https://nabikaran.org",
    },
  ],
};

export default async function Home() {
  const { t, prefs, user } = await getRequestContext();
  const templates = await listDocTemplates(false).catch(() => []);
  const popular = templates.filter((x) => x.popular).slice(0, 10);
  const seoPages = await listSeoPages();
  const cta = user ? "/dashboard" : "/login";
  const n = (v: number) => localizeNumber(v, prefs.lang);
  const words = (["landing.rot1", "landing.rot2", "landing.rot3", "landing.rot4", "landing.rot5"] as const).map((k) => t(k));
  const [pre, post] = t("landing.heroTitle").split("{x}");

  return (
    <>
      <section className="hero-band">
        <div className="aurora" aria-hidden><span /><span /><span /></div>
        <div className="hero-grid-bg" aria-hidden />
        <div className="hero">
          <div className="hero-copy">
            <span className="eyebrow anim-in" style={{ ["--d" as string]: "0ms" }}><span className="pulse-dot" /> {t("landing.badge")}</span>
            <h1 className="anim-in" style={{ ["--d" as string]: "80ms" }}>
              {pre}<RotatingWords words={words} />{post}
            </h1>
            <p className="hero-line anim-in" style={{ ["--d" as string]: "160ms" }}>{t("landing.heroLine")}</p>
            <p className="lead anim-in" style={{ ["--d" as string]: "220ms" }}>{t("landing.subtitle")}</p>
            <div className="row hero-ctas anim-in" style={{ ["--d" as string]: "300ms" }}>
              <Link href={cta} className="btn btn-accent btn-lg btn-shine">{user ? t("nav.dashboard") : t("landing.cta")} <Icon name="arrowRight" size={18} /></Link>
              <a href="#how" className="btn btn-outline-light btn-lg">{t("landing.ctaSecondary")}</a>
            </div>
            <ul className="hero-trust anim-in" style={{ ["--d" as string]: "380ms" }}>
              <li><Icon name="check" size={16} /> {t("landing.f1")}</li>
              <li><Icon name="check" size={16} /> {t("landing.f2")}</li>
              <li><Icon name="check" size={16} /> {t("landing.f3")}</li>
            </ul>
          </div>

          <div className="hero-visual anim-in" style={{ ["--d" as string]: "200ms" }} aria-hidden>
            <div className="phone-mock">
              <div className="notch" />
              <div className="screen">
                <div className="screen-head">
                  <span className="logo-mark sm">न</span>
                  <span><strong>NABIKARAN</strong><small>{t("landing.smsPreview")}</small></span>
                </div>
                <div className="sms-bubble" style={{ ["--i" as string]: 0 }}>{t("landing.sms1")}</div>
                <div className="sms-bubble" style={{ ["--i" as string]: 1 }}>{t("landing.sms2")}</div>
                <div className="sms-bubble" style={{ ["--i" as string]: 2 }}>{t("landing.sms3")}</div>
                <div className="typing" style={{ ["--i" as string]: 3 }}><i /><i /><i /></div>
              </div>
            </div>
            <div className="float-card fc-1">
              <span className="ring" style={{ ["--p" as string]: 0.77 }}><b>{n(7)}</b></span>
              <span><strong>{t("landing.floatDue")}</strong><small>{t("dash.daysLeft", { n: n(7) })}</small></span>
            </div>
            <div className="float-card fc-2">
              <span className="fc-icon ok"><Icon name="check" size={18} /></span>
              <span><strong>{t("landing.floatSent")}</strong><small>{t("landing.floatSentSub")}</small></span>
            </div>
            <div className="float-card fc-3">
              <span className="fc-icon accent"><Icon name="wallet" size={18} /></span>
              <span><strong>{t("landing.floatCredits", { n: n(500) })}</strong><small>{t("landing.floatCreditsSub")}</small></span>
            </div>
          </div>
        </div>
      </section>

      <section className="marquee-wrap" aria-label={t("landing.trackTitle")}>
        <p className="marquee-title">{t("landing.trackTitle")}</p>
        <div className="marquee">
          <div className="marquee-track">
            {[...DOCS, ...DOCS].map((d, i) => (
              <span className="doc-pill" key={i} aria-hidden={i >= DOCS.length || undefined}><Icon name={d.icon} size={16} /> {t(d.key)}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="facts" data-reveal-stagger>
        {([1, 2, 3, 4] as const).map((i) => (
          <div className="fact" data-reveal key={i}>
            <strong>{t(`landing.fact${i}v`)}</strong>
            <span>{t(`landing.fact${i}`)}</span>
          </div>
        ))}
      </section>

      <section className="section" id="how">
        <div className="section-title" data-reveal>
          <span className="kicker">01</span>
          <h2>{t("landing.how")}</h2>
          <p>{t("landing.howSub")}</p>
        </div>
        <div className="steps" data-reveal-stagger>
          {([["file", "landing.step1", "landing.step1d"], ["calendar", "landing.step2", "landing.step2d"], ["message", "landing.step3", "landing.step3d"]] as const).map(([icon, h, d], i) => (
            <div className="step card glow" data-reveal key={h}>
              <div className="step-num">{n(i + 1)}</div>
              <div className="icon-chip"><Icon name={icon} /></div>
              <h3>{t(h)}</h3>
              <p className="muted mb-0">{t(d)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-title" data-reveal>
          <span className="kicker">02</span>
          <h2>{t("landing.features")}</h2>
          <p>{t("landing.featuresSub")}</p>
        </div>
        <div className="bento" data-reveal-stagger>
          <div className="bento-card b-wide card glow" data-reveal>
            <div className="icon-chip"><Icon name="wallet" /></div>
            <h3>{t("landing.f1")}</h3>
            <p className="muted">{t("landing.f1d")}</p>
            <div className="mini-wallet" aria-hidden>
              <div className="mw-bar"><span style={{ width: "72%" }} /></div>
              <div className="row between small"><span>{t("dash.available")}</span><strong>{n(480)}</strong></div>
            </div>
          </div>
          <div className="bento-card card glow" data-reveal>
            <div className="icon-chip orange"><Icon name="zap" /></div>
            <h3>{t("landing.f2")}</h3>
            <p className="muted mb-0">{t("landing.f2d")}</p>
          </div>
          <div className="bento-card card glow" data-reveal>
            <div className="icon-chip yellow"><Icon name="calendar" /></div>
            <h3>{t("landing.f3")}</h3>
            <p className="muted">{t("landing.f3d")}</p>
            <div className="date-flip" aria-hidden><span>{formatDate(SAMPLE_DATE, { ...prefs, date: "BS" })}</span><Icon name="repeat" size={14} /><span>{formatDate(SAMPLE_DATE, { ...prefs, date: "AD" })}</span></div>
          </div>
          <div className="bento-card card glow" data-reveal>
            <div className="icon-chip"><Icon name="message" /></div>
            <h3>{t("landing.f5")}</h3>
            <p className="muted mb-0">{t("landing.f5d")}</p>
          </div>
          <div className="bento-card card glow" data-reveal>
            <div className="icon-chip orange"><Icon name="calendar" /></div>
            <h3>{t("landing.f6")}</h3>
            <p className="muted mb-0">{t("landing.f6d")}</p>
          </div>
          <div className="bento-card b-wide b-dark card glow" data-reveal>
            <div className="icon-chip"><Icon name="sparkle" /></div>
            <h3>{t("landing.f4")}</h3>
            <p className="mb-0">{t("landing.f4d")}</p>
            <div className="chat-demo" aria-hidden>
              <span className="chat-q">“{t("landing.chatQ")}”</span>
              <span className="chat-a"><Icon name="check" size={14} /> {t("landing.floatDue")} · {t("dash.daysLeft", { n: n(7) })}</span>
            </div>
          </div>
        </div>
      </section>

      {popular.length > 0 && (
        <section className="section" data-reveal>
          <div className="section-title"><h2>{t("landing.startWith")}</h2></div>
          <div className="chips" style={{ justifyContent: "center" }}>
            {popular.map((p) => (
              <Link key={p.slug} href={user ? `/renewals/new?template=${p.slug}` : "/login"} className="chip chip-lift">{prefs.lang === "ne" ? p.name_ne : p.name_en}</Link>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="gift-band" data-reveal>
          <div className="gift-copy">
            <span className="kicker light"><Icon name="gift" size={14} /> {t("landing.giftTag")}</span>
            <h2>{t("gift.landingTitle")}</h2>
            <p>{t("gift.landingText")}</p>
            <Link href="/gift" className="btn btn-accent btn-lg btn-shine">{t("gift.landingCta")} <Icon name="arrowRight" size={18} /></Link>
          </div>
          <div className="gift-card-3d" aria-hidden>
            <div className="gc-inner">
              <div className="row between"><span className="logo-mark sm">न</span><span className="gc-tag">{t("landing.giftTag")}</span></div>
              <div className="gc-amount">{t("landing.giftAmount")}</div>
              <div className="gc-code">NBK-GIFT-••••-7Q2X</div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="cta-band" data-reveal>
          <div>
            <h2>{t("landing.pricing")}</h2>
            <p className="mb-0" style={{ opacity: 0.9, maxWidth: 620 }}>{t("landing.pricingd")}</p>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Link href="/pricing" className="btn btn-outline-light btn-lg">{t("nav.pricing")}</Link>
            <Link href={cta} className="btn btn-accent btn-lg btn-shine">{user ? t("nav.dashboard") : t("nav.getStarted")}</Link>
          </div>
        </div>
      </section>

      <section className="section faq-section">
        <div className="section-title" data-reveal><span className="kicker">03</span><h2>{t("landing.faq")}</h2></div>
        <div data-reveal-stagger>
          {(["1", "2", "3"] as const).map((k) => (
            <details className="faq" key={k} data-reveal>
              <summary>{t(`landing.q${k}`)}<span className="faq-icon" aria-hidden><Icon name="plus" size={16} /></span></summary>
              <p className="muted mb-0">{t(`landing.a${k}`)}</p>
            </details>
          ))}
        </div>
        <p className="small muted mt" style={{ textAlign: "center" }}>{t("landing.disclaimer")}</p>
      </section>

      <section className="section final-cta" data-reveal>
        <h2>{t("landing.finalTitle")}</h2>
        <p className="muted">{t("landing.finalSub")}</p>
        <Link href={cta} className="btn btn-primary btn-lg btn-shine">{user ? t("nav.dashboard") : t("landing.cta")} <Icon name="arrowRight" size={18} /></Link>
      </section>

      {prefs.lang === "en" && seoPages.length > 0 && (
        <section className="section" style={{ maxWidth: 760, margin: "0 auto" }}>
          <div className="section-title"><h2>{t("landing.popular")}</h2></div>
          <div className="chips" style={{ justifyContent: "center" }}>
            {seoPages.map((p) => <Link key={p.slug} href={`/renewal-reminder/${p.slug}`} className="chip chip-lift">{p.h1.replace(/ for Nepal|, for Nepal/, "")}</Link>)}
          </div>
        </section>
      )}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ORG_JSON_LD).replace(/</g, "\\u003c") }} />
    </>
  );
}
