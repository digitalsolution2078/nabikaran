import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { webPrincipal } from "@/lib/core/principal";
import { getLedger } from "@/lib/core/wallet";
import { listOrders } from "@/lib/services/payments";
import { listMyManualTopups } from "@/lib/services/manual-topups";
import { listJobsForUser } from "@/lib/core/reminders";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDateTime, localizeNumber } from "@/lib/i18n/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "History" };

export default async function HistoryPage() {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login");
  const p = webPrincipal(user);
  const [ledger, orders, manual, jobs] = await Promise.all([getLedger(p, 200), listOrders(user.id), listMyManualTopups(user.id), listJobsForUser(p, 200)]);
  const n = (v: number) => localizeNumber(v, prefs.lang);
  return (
    <div className="stack">
      <Link href="/wallet" className="small">← {t("wallet.title")}</Link>
      <h1>{t("wallet.history")}</h1>
      <section>
        <h2>{t("nav.wallet")}</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t("common.date")}</th><th>Type</th><th className="hide-mobile">Reference</th><th className="num">{t("rem.credits")}</th></tr></thead>
            <tbody>
              {ledger.map((l) => (
                <tr key={l.id}>
                  <td className="nowrap">{formatDateTime(l.createdAt, prefs)}</td>
                  <td style={{ textTransform: "capitalize" }}>{l.type === "fee" ? t("ledger.fee") : l.type}</td>
                  <td className="small muted hide-mobile">{l.memo ?? `${l.referenceType ?? ""} ${l.referenceId?.slice(0, 8) ?? ""}`}</td>
                  <td className={`num ${l.signedCredits >= 0 ? "plus" : "minus"}`}>{l.signedCredits > 0 ? "+" : ""}{n(l.signedCredits)}</td>
                </tr>
              ))}
              {ledger.length === 0 && <tr><td colSpan={4} className="muted">{t("wallet.noTx")}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h2>{t("wallet.addCredits")}</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Reference</th><th>{t("common.amount")}</th><th>{t("common.status")}</th></tr></thead>
            <tbody>
              {manual.map((m) => (
                <tr key={m.id}><td><Link href={`/wallet/topup/${m.id}`} className="mono">{m.reference}</Link><br /><span className="small muted">QR · {formatDateTime(m.createdAt, prefs)}</span></td><td>{t("common.npr")} {n(m.amountNpr)}</td><td><StatusBadge status={m.status} /></td></tr>
              ))}
              {orders.map((o) => (
                <tr key={o.id}><td className="mono">{o.order_reference}<br /><span className="small muted">{o.gateway} · {formatDateTime(o.created_at, prefs)}</span></td><td>{t("common.npr")} {n(Number(o.amount_paisa) / 100)}</td><td><StatusBadge status={o.status} /></td></tr>
              ))}
              {manual.length + orders.length === 0 && <tr><td colSpan={3} className="muted">{t("common.none")}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h2>SMS</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t("rem.title")}</th><th>{t("rem.sendAt")}</th><th>{t("common.status")}</th></tr></thead>
            <tbody>
              {jobs.map((j) => <tr key={j.id}><td>{j.label}</td><td className="nowrap">{formatDateTime(j.due_at_utc, prefs)}</td><td><StatusBadge status={j.status} /></td></tr>)}
              {jobs.length === 0 && <tr><td colSpan={3} className="muted">{t("dash.noneSms")}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
