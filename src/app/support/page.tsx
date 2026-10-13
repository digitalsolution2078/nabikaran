import Link from "next/link";
import { getRequestContext } from "@/lib/i18n/server";
import { listMyTickets } from "@/lib/services/support";
import { SupportForm } from "@/components/support/SupportForm";
import { TicketStatusBadge } from "@/components/support/TicketThread";
import { Icon } from "@/components/Icon";
import { formatDate } from "@/lib/i18n/format";
import type { MessageKey } from "@/lib/i18n/dict";

export const dynamic = "force-dynamic";
export const metadata = { title: "Help & support" };

export default async function SupportPage() {
  const { t, user, prefs } = await getRequestContext();
  const tickets = user ? await listMyTickets(user.id) : [];
  return (
    <div className="stack support-page">
      <div className="page-head">
        <div>
          <h1>{t("sup.title")}</h1>
          <p>{t("sup.subtitle")}</p>
        </div>
      </div>
      <div className="support-grid">
        <SupportForm signedIn={Boolean(user)} />
        <aside className="stack">
          {user && (
            <section className="card">
              <h2>{t("sup.myTickets")}</h2>
              {tickets.length === 0 ? <p className="muted mb-0">{t("sup.none")}</p> : (
                <div className="list">
                  {tickets.map((k) => (
                    <Link key={k.id} href={`/support/${k.id}`} className="list-item" style={{ color: "inherit", textDecoration: "none" }}>
                      <span className="avatar-icon"><Icon name="message" /></span>
                      <span className="grow">
                        <span className="title" style={{ display: "block" }}>{k.subject}</span>
                        <span className="meta">{k.ref} · {t(`sup.cat.${k.category}` as MessageKey)} · {formatDate(k.updatedAt, prefs)}</span>
                      </span>
                      <TicketStatusBadge status={k.status} />
                    </Link>
                  ))}
                </div>
              )}
            </section>
          )}
          <section className="card">
            <h2>{t("sup.quick")}</h2>
            <details className="faq"><summary>{t("sup.q1")}<span className="faq-icon" aria-hidden><Icon name="plus" size={16} /></span></summary><p className="muted mb-0">{t("sup.a1")}</p></details>
            <details className="faq"><summary>{t("sup.q2")}<span className="faq-icon" aria-hidden><Icon name="plus" size={16} /></span></summary><p className="muted mb-0">{t("sup.a2")}</p></details>
          </section>
        </aside>
      </div>
    </div>
  );
}
