import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { listMyManualTopups } from "@/lib/services/manual-topups";
import { getSetting } from "@/lib/services/settings";
import { QrSubmit } from "@/components/QrSubmit";
import { CopyField } from "@/components/CopyField";
import { StatusBadge } from "@/components/StatusBadge";
import { Icon } from "@/components/Icon";
import { formatDateTime, localizeNumber } from "@/lib/i18n/format";
import { formatPhoneLocal } from "@/lib/phone";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pay with QR" };

/**
 * Manual QR payment page. The configured QR is a static Fonepay merchant QR,
 * so the exact amount and the unique reference are shown beside it and the
 * customer enters them in their app. Nothing here edits the QR payload.
 */
export default async function QrPayPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login");
  const { id } = await params;
  const mine = await listMyManualTopups(user.id);
  const r = mine.find((m) => m.id === id);
  if (!r) notFound();
  const qr = await getSetting("manual_qr");
  const amount = localizeNumber(r.amountNpr, prefs.lang);
  const firstName = user.displayName?.split(/\s+/)[0] ?? "";

  return (
    <div className="stack">
      <Link href="/wallet" className="small">← {t("wallet.title")}</Link>
      <div className="page-head">
        <div><h1>{t("qr.title")}</h1><p>{t("common.npr")} {amount} → {localizeNumber(r.credits, prefs.lang)} {t("common.credits")}</p></div>
        <StatusBadge status={r.status} />
      </div>

      {r.status === "pending" && <div className="alert info"><Icon name="clock" /><span><strong>{t("qr.waiting")}</strong><br />{t("qr.waitingd")}</span></div>}
      {r.status === "approved" && <div className="alert ok"><Icon name="check" /><span><strong>{t("qr.approved")}</strong></span></div>}
      {r.status === "rejected" && <div className="alert bad"><Icon name="alert" /><span><strong>{t("qr.rejected")}</strong>{r.decisionNotes ? ` — ${r.decisionNotes}` : ""}</span></div>}

      {r.status === "awaiting_payment" && (
        <div className="grid grid-2" style={{ alignItems: "start" }}>
          <section className="card">
            <ol className="steps-list">
              <li>{t("qr.step1")}</li>
              <li>{t("qr.step2")}</li>
              <li>{t("qr.step3")}</li>
              <li>{t("qr.step4")}</li>
            </ol>
            <div className="qr-box mt">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr.image_path} alt={`${qr.network} QR — ${qr.merchant_name}`} width={320} height={483} />
            </div>
            <dl className="kv mt">
              <dt>{t("qr.merchant")}</dt><dd>{qr.merchant_name}</dd>
              <dt>Network</dt><dd>{qr.network}{qr.terminal_id ? ` · ${qr.terminal_id}` : ""}</dd>
            </dl>
            {!qr.verified && <div className="alert warn mt"><Icon name="alert" /> {t("qr.unverifiedMerchant")}</div>}
            <p className="hint mt mb-0">{t("qr.static")}</p>
          </section>
          <section className="card">
            <div className="field"><span className="label">{t("qr.amount")}</span><CopyField value={String(r.amountNpr)} display={`${t("common.npr")} ${amount}`} /></div>
            <div className="field"><span className="label">{t("qr.reference")}</span><CopyField value={r.reference} /></div>
            <p className="small muted">
              Remarks: <span className="mono">{r.reference} {formatPhoneLocal(user.phoneE164).replace(/-/g, "")}{firstName ? ` ${firstName}` : ""}</span>
            </p>
            <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />
            <QrSubmit requestId={r.id} />
          </section>
        </div>
      )}

      {r.status !== "awaiting_payment" && (
        <section className="card">
          <dl className="kv">
            <dt>{t("qr.reference")}</dt><dd className="mono">{r.reference}</dd>
            <dt>{t("qr.amount")}</dt><dd>{t("common.npr")} {amount}</dd>
            {r.payerTxnRef && (<><dt>{t("qr.txnId")}</dt><dd className="mono">{r.payerTxnRef}</dd></>)}
            {r.submittedAt && (<><dt>{t("common.date")}</dt><dd>{formatDateTime(r.submittedAt, prefs)}</dd></>)}
          </dl>
        </section>
      )}
    </div>
  );
}
