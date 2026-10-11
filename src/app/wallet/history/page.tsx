import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { getStatement, listTopups, type LedgerCategory } from "@/lib/services/wallet-report";
import { StatusBadge } from "@/components/StatusBadge";
import { ChannelBadge } from "@/components/ChannelBadge";
import { Icon } from "@/components/Icon";
import { formatDateTime, localizeNumber } from "@/lib/i18n/format";
import type { MessageKey } from "@/lib/i18n/dict";

export const dynamic = "force-dynamic";
export const metadata = { title: "Wallet history" };

const CAT_KEY: Record<LedgerCategory, MessageKey> = {
  purchased: "ledger.purchased", spent_sms: "ledger.spentSms", spent_whatsapp: "ledger.spentWa", refunded: "ledger.refunded",
  reversed: "ledger.reversed", fee: "ledger.fee", adjustment: "ledger.adjustment", bonus: "ledger.bonus",
  spent_email: "ledger.spentEmail", plan: "ledger.plan", coupon: "ledger.coupon",
};

export default async function HistoryPage() {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login?next=/wallet/history");
  const [st, topups] = await Promise.all([getStatement(user.id), listTopups(user.id)]);
  const n = (v: number) => localizeNumber(v, prefs.lang);
  const tiles: Array<[MessageKey, number]> = [
    ["ledger.purchased", st.totals.purchased],
    ["ledger.spentSms", -st.totals.spent_sms],
    ["ledger.spentWa", -st.totals.spent_whatsapp],
    ["ledger.refunded", st.totals.refunded],
    ["ledger.fee", -st.totals.fee],
    ...(st.totals.bonus ? [["ledger.bonus", st.totals.bonus] as [MessageKey, number]] : []),
    ...(st.totals.spent_email ? [["ledger.spentEmail", -st.totals.spent_email] as [MessageKey, number]] : []),
    ...(st.totals.plan ? [["ledger.plan", -st.totals.plan] as [MessageKey, number]] : []),
    ...(st.totals.coupon ? [["ledger.coupon", st.totals.coupon] as [MessageKey, number]] : []),
    ["wallet.reserved", st.wallet.reserved],
  ];
  return (
    <div className="stack">
      <Link href="/wallet" className="small">← {t("wallet.title")}</Link>
      <div className="page-head"><div><h1>{t("wallet.history")}</h1><p>{t("ledger.intro")}</p></div></div>

      <div className="stat-grid">
        {tiles.map(([k, v]) => <div key={k} className="stat"><div className="label">{t(k)}</div><div className="value value-sm">{n(v)}</div></div>)}
      </div>
      <p className="small muted">{t("wallet.available")}: <strong>{n(st.wallet.available)}</strong> · {t("ledger.balanceNote")}</p>

      <section className="card">
        <h2>{t("ledger.topups")}</h2>
        {topups.length === 0 ? (
          <div className="empty"><div className="icon-wrap"><Icon name="wallet" size={24} /></div><p>{t("ledger.noTopups")}</p><Link href="/wallet" className="btn btn-primary btn-sm">{t("dash.topUp")}</Link></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t("common.date")}</th><th>{t("ledger.method")}</th><th>{t("qr.reference")}</th><th className="num">{t("common.amount")}</th><th>{t("common.status")}</th><th /></tr></thead>
              <tbody>
                {topups.map((r) => (
                  <tr key={`${r.kind}-${r.id}`}>
                    <td className="nowrap small">{formatDateTime(r.createdAt, prefs)}</td>
                    <td className="small">{r.method}</td>
                    <td className="mono small">{r.kind === "qr" ? <Link href={`/wallet/topup/${r.id}`}>{r.reference}</Link> : r.reference}</td>
                    <td className="num">{t("common.npr")} {n(r.amountNpr)}<br /><span className="small muted">{n(r.credits)} {t("common.credits")}</span></td>
                    <td><StatusBadge status={r.status} /></td>
                    <td>{r.receipt && <Link href={`/wallet/receipt/${r.kind}/${r.id}`} className="small"><Icon name="receipt" size={14} /> {t("ledger.receipt")}</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>{t("ledger.title")}</h2>
        {st.rows.length === 0 ? (
          <p className="muted mb-0">{t("wallet.noTx")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t("common.date")}</th><th>{t("ledger.type")}</th><th className="hide-mobile">{t("ledger.detail")}</th><th className="num">{t("rem.credits")}</th></tr></thead>
              <tbody>
                {st.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap small">{formatDateTime(r.createdAt, prefs)}</td>
                    <td>{t(CAT_KEY[r.category])} {r.channel && <ChannelBadge channel={r.channel} />}</td>
                    <td className="small muted hide-mobile">{r.description}{r.reference ? ` · ${r.reference.slice(0, 12)}` : ""}</td>
                    <td className={`num ${r.credits >= 0 ? "plus" : "minus"}`}>{r.credits > 0 ? "+" : ""}{n(r.credits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
