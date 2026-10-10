import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { webPrincipal } from "@/lib/core/principal";
import { getWallet, getLedger } from "@/lib/core/wallet";
import { getSetting } from "@/lib/services/settings";
import { listMyManualTopups } from "@/lib/services/manual-topups";
import { AddCredits } from "@/components/AddCredits";
import { StatusBadge } from "@/components/StatusBadge";
import { Icon } from "@/components/Icon";
import { DraftResume } from "@/components/DraftResume";
import { fonepayEnabled } from "@/lib/providers/payments/fonepay";
import { formatDateTime, localizeNumber } from "@/lib/i18n/format";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Wallet" };

export default async function WalletPage({ searchParams }: { searchParams: Promise<{ payment?: string; amount?: string }> }) {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login");
  const p = webPrincipal(user);
  const { payment, amount } = await searchParams;
  const [wallet, ledger, limits, qr, manual] = await Promise.all([getWallet(p), getLedger(p, 6), getSetting("topup"), getSetting("manual_qr"), listMyManualTopups(user.id)]);
  const open = manual.filter((m) => m.status === "awaiting_payment" || m.status === "pending");
  const n = (v: number) => localizeNumber(v, prefs.lang);
  return (
    <div className="stack">
      <div className="page-head"><div><h1>{t("wallet.title")}</h1><p>{t("wallet.noExpiry")}</p></div></div>
      {payment === "success" && <div className="alert ok"><Icon name="check" /> {t("wallet.paymentVerified")}</div>}
      {payment?.startsWith("pending") && <div className="alert warn"><Icon name="clock" /> {t("wallet.paymentPending")}</div>}
      <DraftResume />
      {wallet.available < 0 && <div className="alert warn"><Icon name="alert" /> <span>{t("wallet.negative")}</span></div>}
      {(payment === "mismatch" || payment === "error" || payment === "invalid") && <div className="alert bad"><Icon name="alert" /> {t("wallet.paymentFailed")}</div>}

      <div className="grid grid-3">
        <div className="stat stat-hero"><div className="label"><span className="icon-chip"><Icon name="wallet" size={16} /></span>{t("wallet.available")}</div><div className="value">{n(wallet.available)}</div><div className="sub">{t("common.credits")}</div></div>
        <div className="stat"><div className="label"><span className="icon-chip yellow"><Icon name="lock" size={16} /></span>{t("wallet.reserved")}</div><div className="value">{n(wallet.reserved)}</div></div>
        <div className="stat"><div className="label"><span className="icon-chip orange"><Icon name="chart" size={16} /></span>{t("wallet.total")}</div><div className="value">{n(wallet.posted)}</div></div>
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card" id="add">
          <h2>{t("wallet.addCredits")}</h2>
          <AddCredits initialAmount={amount && /^\d{1,6}$/.test(amount) ? Math.min(limits.max_npr, Math.max(limits.min_npr, Number(amount))) : undefined} min={limits.min_npr} max={limits.max_npr} quick={limits.quick_amounts} qrEnabled={qr.enabled} khaltiEnabled={env.paymentGateway !== "none"} qrAutomatic={fonepayEnabled()} />
        </section>
        <div className="stack">
          <section className="card">
            <div className="card-head"><h2>{t("wallet.pending")}</h2></div>
            {open.length === 0 ? <p className="muted mb-0">{t("common.none")}</p> : (
              <div className="list">
                {open.map((m) => (
                  <Link key={m.id} href={`/wallet/topup/${m.id}`} className="list-item" style={{ color: "inherit", textDecoration: "none" }}>
                    <span className="avatar-icon"><Icon name="qr" /></span>
                    <span className="grow"><span className="title" style={{ display: "block" }}>{t("common.npr")} {n(m.amountNpr)} · <span className="mono">{m.reference}</span></span><span className="meta">{formatDateTime(m.createdAt, prefs)}</span></span>
                    <StatusBadge status={m.status} />
                  </Link>
                ))}
              </div>
            )}
          </section>
          <section className="card">
            <div className="card-head"><h2>{t("wallet.history")}</h2><Link href="/wallet/history" className="small">{t("wallet.viewAll")}</Link></div>
            {ledger.length === 0 ? <p className="muted mb-0">{t("wallet.noTx")}</p> : (
              <div className="list">
                {ledger.map((l) => (
                  <div key={l.id} className="list-item">
                    <span className="grow"><span className="title" style={{ display: "block", textTransform: "capitalize" }}>{l.type === "fee" ? t("ledger.fee") : l.type === "referral" ? t("ledger.bonus") : `${l.type}${l.memo ? ` · ${l.memo}` : ""}`}</span><span className="meta">{formatDateTime(l.createdAt, prefs)}</span></span>
                    <span className={l.signedCredits >= 0 ? "plus" : "minus"}>{l.signedCredits > 0 ? "+" : ""}{n(l.signedCredits)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
