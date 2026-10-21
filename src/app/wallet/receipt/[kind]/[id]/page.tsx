import { notFound, redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { getReceipt } from "@/lib/services/wallet-report";
import { PrintButton } from "@/components/PrintButton";
import { formatPhoneLocal } from "@/lib/phone";

export const dynamic = "force-dynamic";
export const metadata = { title: "Receipt" };

/** Printable payment receipt (Print → Save as PDF). Not a tax invoice. */
export default async function ReceiptPage({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const { user, t } = await getRequestContext();
  const { kind, id } = await params;
  if (!user) redirect(`/login?next=/wallet/receipt/${kind}/${id}`);
  if ((kind !== "khalti" && kind !== "qr") || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = await getReceipt(kind, id, user.id);
  if (!r) notFound();
  const when = new Date(r.issuedAt).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "long", timeStyle: "short" });
  return (
    <div className="receipt">
      <div className="row between no-print"><a href="/wallet/history" className="small">← {t("rcpt.back")}</a><PrintButton /></div>
      <header className="row between">
        <div><h1 className="mb-0">Nabikaran</h1><p className="small muted mb-0">{t("rcpt.title")} · nabikaran.org</p></div>
        <div className="small" style={{ textAlign: "right" }}><strong>{r.number}</strong><br />{when} NPT</div>
      </header>
      <dl className="kv mt">
        <dt>{t("rcpt.customer")}</dt><dd>{r.customerName ? `${r.customerName} · ` : ""}{formatPhoneLocal(r.customerPhone)}</dd>
        <dt>{t("rcpt.method")}</dt><dd>{r.method}</dd>
        <dt>{t("rcpt.ref")}</dt><dd className="mono">{r.reference}</dd>
        {r.bankReference && (<><dt>{t("rcpt.txn")}</dt><dd className="mono">{r.bankReference}</dd></>)}
        <dt>{t("rcpt.amount")}</dt><dd><strong>NPR {r.amountNpr.toLocaleString("en-IN")}</strong></dd>
        <dt>{t("rcpt.credits")}</dt><dd>{r.credits.toLocaleString("en-IN")} ({t("rcpt.creditsNote")})</dd>
      </dl>
      <p className="small muted mt">{t("rcpt.footer")}</p>
    </div>
  );
}
