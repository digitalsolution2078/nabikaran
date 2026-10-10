import Link from "next/link";
import { getRequestContext } from "@/lib/i18n/server";
import { Icon } from "@/components/Icon";
import { listDocTemplates } from "@/lib/services/admin-console";
import { listSeoPages } from "@/lib/services/seo";

export default async function Home() {
  const { t, prefs, user } = await getRequestContext();
  const templates = await listDocTemplates(false).catch(() => []);
  const popular = templates.filter((x) => x.popular).slice(0, 10);
  const seoPages = await listSeoPages();
  const cta = user ? "/dashboard" : "/login";
  return (
    <>
      <section className="hero">
        <div>
          <span className="eyebrow"><Icon name="zap" size={16} /> {t("landing.badge")}</span>
          <h1>Nepal ko personal <span className="hl">renewal command center.</span></h1>
          <p className="small muted mb-0">{prefs.lang === "ne" ? "हरेक नवीकरण, समयमै — SMS र WhatsApp मा।" : "Every renewal, on time — by SMS and WhatsApp."}</p>
          <p className="lead">{t("landing.subtitle")}</p>
          <div className="row mt">
            <Link href={cta} className="btn btn-primary btn-lg">{user ? t("nav.dashboard") : t("landing.cta")} <Icon name="arrowRight" size={18} /></Link>
            <a href="#how" className="btn btn-secondary btn-lg">{t("landing.ctaSecondary")}</a>
          </div>
          <div className="row mt small muted">
            <span className="row"><Icon name="check" size={16} /> {t("landing.f1")}</span>
            <span className="row"><Icon name="check" size={16} /> {t("landing.f2")}</span>
            <span className="row"><Icon name="check" size={16} /> {t("landing.f3")}</span>
          </div>
        </div>
        <div aria-hidden>
          <div className="phone-mock">
            <div className="screen">
              <div className="small" style={{ fontWeight: 700, marginBottom: 12, color: "var(--brand-900)" }}>Messages · NABIKARAN</div>
              <div className="sms-bubble"><div className="from">NABIKARAN</div>Nabikaran: Your Bluebook expires in 7 day(s) on 2026-11-02. Please renew on time.</div>
              <div className="sms-bubble"><div className="from">NABIKARAN</div>Nabikaran: Tapaiko Driving Licence ko myad 30 din pachhi (2026-12-15) sakinchha. Samayamai nabikaran garnuhos.</div>
              <div className="sms-bubble"><div className="from">NABIKARAN</div>Nabikaran: Your Passport expires in 180 day(s) on 2027-04-20. Please renew on time.</div>
              <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
                <span className="badge ok">1 SMS</span><span className="badge info">GSM-7</span><span className="badge warn">BS · AD</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <div className="section-title"><h2>{t("landing.how")}</h2></div>
        <div className="grid grid-3">
          {([["file", "landing.step1", "landing.step1d"], ["calendar", "landing.step2", "landing.step2d"], ["message", "landing.step3", "landing.step3d"]] as const).map(([icon, h, d], i) => (
            <div className="card feature" key={h}>
              <div className="icon-chip"><Icon name={icon} /></div>
              <div className="small muted">{prefs.lang === "ne" ? ["१", "२", "३"][i] : i + 1}</div>
              <h3>{t(h)}</h3>
              <p className="muted mb-0">{t(d)}</p>
            </div>
          ))}
        </div>
      </section>

      {popular.length > 0 && (
        <section className="section">
          <div className="section-title"><h2>{t("rem.popular")}</h2></div>
          <div className="chips" style={{ justifyContent: "center" }}>
            {popular.map((p) => (
              <Link key={p.slug} href={user ? `/renewals/new?template=${p.slug}` : "/login"} className="chip">{prefs.lang === "ne" ? p.name_ne : p.name_en}</Link>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-title"><h2>{t("landing.features")}</h2></div>
        <div className="grid grid-4">
          {([["wallet", "landing.f1", "landing.f1d"], ["zap", "landing.f2", "landing.f2d"], ["calendar", "landing.f3", "landing.f3d"], ["sparkle", "landing.f4", "landing.f4d"]] as const).map(([icon, h, d]) => (
            <div className="card feature" key={h}>
              <div className="icon-chip"><Icon name={icon} /></div>
              <h3>{t(h)}</h3>
              <p className="muted mb-0 small">{t(d)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="cta-band">
          <div>
            <h2>{t("landing.pricing")}</h2>
            <p className="mb-0" style={{ opacity: 0.9, maxWidth: 620 }}>{t("landing.pricingd")}</p>
          </div>
          <Link href={cta} className="btn btn-accent btn-lg">{user ? t("nav.dashboard") : t("nav.getStarted")}</Link>
        </div>
      </section>

      <section className="section" style={{ maxWidth: 760, margin: "0 auto" }}>
        <div className="section-title"><h2>{t("landing.faq")}</h2></div>
        {(["1", "2", "3"] as const).map((n) => (
          <details className="faq" key={n}>
            <summary>{t(`landing.q${n}`)}</summary>
            <p className="muted mt mb-0">{t(`landing.a${n}`)}</p>
          </details>
        ))}
        <p className="small muted mt" style={{ textAlign: "center" }}>{t("landing.disclaimer")}</p>
      </section>

      <section className="section" style={{ maxWidth: 760, margin: "0 auto" }}>
        <div className="section-title"><h2>{prefs.lang === "ne" ? "लोकप्रिय सम्झना" : "Popular reminders"}</h2></div>
        <div className="chips" style={{ justifyContent: "center" }}>
          {seoPages.map((p) => <Link key={p.slug} href={`/renewal-reminder/${p.slug}`} className="chip">{p.h1.replace(/ for Nepal|, for Nepal/, "")}</Link>)}
        </div>
      </section>
    </>
  );
}
