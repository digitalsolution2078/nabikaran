import Link from "next/link";
import { listSeoPages } from "@/lib/services/seo";
import { getRequestContext } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export const metadata = { title: "Renewal reminders for Nepal", description: "SMS and WhatsApp reminders for bluebook, driving licence, passport, vehicle tax, insurance, company and domain renewals in Nepal.", alternates: { canonical: "/renewal-reminder" } };

export default async function SeoIndex() {
  const [pages, { t }] = await Promise.all([listSeoPages(), getRequestContext()]);
  return (
    <article className="legal">
      <h1>{t("seo.indexTitle")}</h1>
      <p className="lead">{t("seo.indexLead")}</p>
      <ul className="seo-index">
        {pages.map((p) => <li key={p.slug}><Link href={`/renewal-reminder/${p.slug}`}><strong>{p.h1}</strong></Link><br /><span className="small muted">{p.description}</span></li>)}
      </ul>
    </article>
  );
}
