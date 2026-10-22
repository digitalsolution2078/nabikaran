import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getSeoPage } from "@/lib/services/seo";
import { env } from "@/lib/env";
import { getRequestContext } from "@/lib/i18n/server";
import { templateInfo } from "@/lib/services/admin-console";

// Pages are editable by admins, so they are rendered per request.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const p = await getSeoPage((await params).slug);
  if (!p) return {};
  const url = `${env.appUrl}/renewal-reminder/${p.slug}`;
  return { title: p.title, description: p.description, alternates: { canonical: url }, openGraph: { title: p.title, description: p.description, url, type: "article" } };
}

export default async function SeoLanding({ params }: { params: Promise<{ slug: string }> }) {
  const p = await getSeoPage((await params).slug);
  if (!p) notFound();
  const { t, prefs } = await getRequestContext();
  const info = await templateInfo(p.template);
  const start = p.template ? `/renewals/new?template=${p.template}` : "/renewals/new";
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: p.faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <article className="legal seo">
      <p className="small"><Link href="/renewal-reminder">{t("seo.crumb")}</Link></p>
      <h1>{p.h1}</h1>
      <p className="lead">{p.intro}</p>
      <p lang="ne">{p.nepali}</p>
      <div className="row mt">
        <Link href={`/login?next=${encodeURIComponent(start)}`} className="btn btn-primary btn-lg">{t("seo.start")}</Link>
        <Link href="/" className="btn btn-secondary btn-lg">{t("seo.how")}</Link>
      </div>

      <h2>{t("seo.what")}</h2>
      <ul>{p.remindWhat.map((w) => <li key={w}>{w}</li>)}</ul>

      <h2>{t("seo.schedule")}</h2>
      <p>{p.schedule} {t("seo.scheduleTail")}</p>

      {info && (<>
        <h2>{t("tpl.infoTitle")}</h2>
        <p style={{ whiteSpace: "pre-line" }}>{prefs.lang === "ne" && info.ne ? info.ne : info.en}</p>
        <p className="hint">{t("tpl.infoHint")}</p>
      </>)}

      <h2>{t("seo.steps")}</h2>
      <ol>
        <li>{t("seo.step1")}</li>
        <li>{t("seo.step2")}</li>
        <li>{t("seo.step3")}</li>
      </ol>

      <div className="alert info"><span><strong>{t("seo.noteTitle")}</strong> {t("seo.note")}</span></div>

      <h2>{t("seo.faq")}</h2>
      {p.faqs.map((f) => <details key={f.q}><summary><strong>{f.q}</strong></summary><p>{f.a}</p></details>)}

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
    </article>
  );
}
