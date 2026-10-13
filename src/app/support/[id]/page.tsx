import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getRequestContext } from "@/lib/i18n/server";
import { getTicketForCustomer } from "@/lib/services/support";
import { TicketStatusBadge, TicketThread } from "@/components/support/TicketThread";
import type { MessageKey } from "@/lib/i18n/dict";

export const dynamic = "force-dynamic";
export const metadata = { title: "Support ticket" };

export default async function MyTicket({ params }: { params: Promise<{ id: string }> }) {
  const { t, user } = await getRequestContext();
  const { id } = await params;
  if (!user) redirect(`/login?next=/support/${encodeURIComponent(id)}`);
  if (!z.string().uuid().safeParse(id).success) notFound();
  const found = await getTicketForCustomer({ userId: user.id, ticketId: id });
  if (!found) notFound();
  const k = found.ticket;
  return (
    <div className="stack support-page">
      <Link href="/support" className="small">← {t("sup.back")}</Link>
      <div className="page-head">
        <div>
          <h1>{k.subject}</h1>
          <p>{k.ref} · {t(`sup.cat.${k.category}` as MessageKey)}</p>
        </div>
        <TicketStatusBadge status={k.status} />
      </div>
      <TicketThread messages={found.messages} status={k.status} replyUrl={`/api/support/tickets/${k.id}`} />
    </div>
  );
}
