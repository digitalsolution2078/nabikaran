import { getRequestContext } from "@/lib/i18n/server";
import { getTicketForCustomer } from "@/lib/services/support";
import { TicketStatusBadge, TicketThread } from "@/components/support/TicketThread";
import type { MessageKey } from "@/lib/i18n/dict";

export const dynamic = "force-dynamic";
export const metadata = { title: "Support ticket", robots: { index: false, follow: false } };

/** A visitor's ticket, opened with the private link they got when they sent it. */
export default async function GuestTicket({ params }: { params: Promise<{ token: string }> }) {
  const { t } = await getRequestContext();
  const { token } = await params;
  const found = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? await getTicketForCustomer({ token }) : null;
  if (!found) {
    return <div className="card" style={{ maxWidth: 560, margin: "40px auto" }}><h1>{t("sup.title")}</h1><p className="muted mb-0">{t("sup.notFound")}</p></div>;
  }
  const k = found.ticket;
  return (
    <div className="stack support-page" style={{ maxWidth: 820, margin: "0 auto" }}>
      <div className="page-head">
        <div>
          <h1>{k.subject}</h1>
          <p>{k.ref} · {t(`sup.cat.${k.category}` as MessageKey)}</p>
        </div>
        <TicketStatusBadge status={k.status} />
      </div>
      <TicketThread messages={found.messages} status={k.status} replyUrl={`/api/support/guest/${token}`} token={token} />
    </div>
  );
}
