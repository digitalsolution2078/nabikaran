import { notFound, redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { getReceipt } from "@/lib/services/wallet-report";
import { PrintButton } from "@/components/PrintButton";
import { formatPhoneLocal } from "@/lib/phone";

export const dynamic = "force-dynamic";
export const metadata = { title: "Receipt" };

/** Printable payment receipt (Print → Save as PDF). Not a tax invoice. */
export default async function ReceiptPage({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const { user } = await getRequestContext();
  const { kind, id } = await params;
  if (!user) redirect(`/login?next=/wallet/receipt/${kind}/${id}`);
  if ((kind !== "khalti" && kind !== "qr") || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = await getReceipt(kind, id, user.id);
  if (!r) notFound();
  const when = new Date(r.issuedAt).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "long", timeStyle: "short" });
  return (
    <div className="receipt">
      <div className="row between no-print"><a href="/wallet/history" className="small">← Wallet history</a><PrintButton /></div>
      <header className="row between">
        <div><h1 className="mb-0">Nabikaran</h1><p className="small muted mb-0">Payment receipt · nabikaran.org</p></div>
        <div className="small" style={{ textAlign: "right" }}><strong>{r.number}</strong><br />{when} NPT</div>
      </header>
      <dl className="kv mt">
        <dt>Customer</dt><dd>{r.customerName ? `${r.customerName} · ` : ""}{formatPhoneLocal(r.customerPhone)}</dd>
        <dt>Payment method</dt><dd>{r.method}</dd>
        <dt>Payment reference</dt><dd className="mono">{r.reference}</dd>
        {r.bankReference && (<><dt>Transaction reference</dt><dd className="mono">{r.bankReference}</dd></>)}
        <dt>Amount paid</dt><dd><strong>NPR {r.amountNpr.toLocaleString("en-IN")}</strong></dd>
        <dt>Credits added</dt><dd>{r.credits.toLocaleString("en-IN")} (1 credit = NPR 1, prepaid, no expiry)</dd>
      </dl>
      <p className="small muted mt">This receipt confirms a prepaid credit top-up for the Nabikaran reminder service. It is not a VAT/tax invoice. Credits are used for SMS and WhatsApp reminders at the prices shown before each reminder is saved.</p>
    </div>
  );
}
