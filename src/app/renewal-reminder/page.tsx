import Link from "next/link";
import { SEO_PAGES } from "@/lib/seo-pages";

export const metadata = { title: "Renewal reminders for Nepal | Nabikaran", description: "SMS and WhatsApp reminders for bluebook, driving licence, passport, vehicle tax, insurance, company and domain renewals in Nepal." };

export default function SeoIndex() {
  return (
    <article className="legal">
      <h1>Renewal reminders for Nepal</h1>
      <p className="lead">Nepal ko personal renewal command center: every renewal date in one place, with SMS and WhatsApp reminders before each one.</p>
      <ul className="seo-index">
        {SEO_PAGES.map((p) => <li key={p.slug}><Link href={`/renewal-reminder/${p.slug}`}><strong>{p.h1}</strong></Link><br /><span className="small muted">{p.description}</span></li>)}
      </ul>
    </article>
  );
}
