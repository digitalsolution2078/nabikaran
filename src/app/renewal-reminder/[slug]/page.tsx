import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getSeoPage } from "@/lib/services/seo";
import { env } from "@/lib/env";

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
  const start = p.template ? `/renewals/new?template=${p.template}` : "/renewals/new";
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: p.faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <article className="legal seo">
      <p className="small"><Link href="/renewal-reminder">Renewal reminders</Link></p>
      <h1>{p.h1}</h1>
      <p className="lead">{p.intro}</p>
      <p lang="ne">{p.nepali}</p>
      <div className="row mt">
        <Link href={`/login?next=${encodeURIComponent(start)}`} className="btn btn-primary btn-lg">Set up this reminder</Link>
        <Link href="/" className="btn btn-secondary btn-lg">How Nabikaran works</Link>
      </div>

      <h2>What you can be reminded about</h2>
      <ul>{p.remindWhat.map((w) => <li key={w}>{w}</li>)}</ul>

      <h2>A sensible schedule</h2>
      <p>{p.schedule} You choose SMS, WhatsApp or both, and see the exact message and credit cost before saving. Credits are prepaid (1 credit = NPR 1) and never expire.</p>

      <h2>How it works</h2>
      <ol>
        <li>Sign in with your mobile number.</li>
        <li>Pick the document, enter the expiry date from your own document (BS or AD), and confirm the converted date.</li>
        <li>Choose when and how to be reminded, check the message and cost, and save.</li>
      </ol>

      <div className="alert info"><span><strong>Reminder service only.</strong> Nabikaran does not renew documents, does not connect to government databases, and cannot guarantee handset delivery. Always confirm renewal rules with the issuing office.</span></div>

      <h2>Questions</h2>
      {p.faqs.map((f) => <details key={f.q}><summary><strong>{f.q}</strong></summary><p>{f.a}</p></details>)}

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
    </article>
  );
}
