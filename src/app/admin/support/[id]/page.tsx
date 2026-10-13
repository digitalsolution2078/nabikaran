import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { getTicketForStaff } from "@/lib/services/support";
import { TicketAdmin } from "@/components/admin/TicketAdmin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Support ticket" };

export default async function AdminTicket({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireAdminPage("support.manage");
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const found = await getTicketForStaff(id);
  if (!found) notFound();
  const k = found.ticket;
  return (
    <div className="stack">
      <Link href="/admin/support" className="small">← Support</Link>
      <section className="card">
        <div className="row between">
          <div>
            <h2 className="mb-0">{k.ref} · {k.subject}</h2>
            <span className="small muted">{k.category} · opened {new Date(k.createdAt).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu" })}</span>
          </div>
          <span className={`badge ${k.status === "open" ? "info" : k.status === "waiting_customer" ? "warn" : k.status === "resolved" ? "ok" : ""}`}>{k.status.replace("_", " ")}</span>
        </div>
        <dl className="kv mt">
          <dt>Customer</dt>
          <dd>{k.customer.userId ? <Link href={`/admin/users/${k.customer.userId}`}>{k.customer.name ?? k.customer.phone}</Link> : <>{k.customer.name} <span className="badge">visitor</span></>}</dd>
          <dt>Contact</dt><dd>{[k.customer.phone, k.customer.email].filter(Boolean).join(" · ") || "—"}</dd>
          <dt>Assigned</dt><dd>{k.assignedTo ?? "—"}</dd>
          <dt>Notify on reply</dt><dd className="small">{k.customer.userId ? "App notification" : ""}{k.customer.userId && k.customer.email ? " + " : ""}{k.customer.email ? "email" : ""}{!k.customer.userId && !k.customer.email ? "None — the visitor checks their private link. Call or SMS them if urgent." : ""}</dd>
        </dl>
      </section>
      <TicketAdmin ticketId={k.id} status={k.status} priority={k.priority} assignedToMe={k.assignedToId === me.id} messages={found.messages} customerName={k.customer.name ?? k.customer.phone ?? "Customer"} />
    </div>
  );
}
