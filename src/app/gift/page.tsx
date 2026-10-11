import Link from "next/link";
import { getRequestContext } from "@/lib/i18n/server";
import { getSetting } from "@/lib/services/settings";
import { giftRules, listMyGiftCards } from "@/lib/services/credit-codes";
import { GiftBuy } from "@/components/GiftBuy";
import { GiftShare } from "@/components/GiftShare";
import { StatusBadge } from "@/components/StatusBadge";
import { Icon } from "@/components/Icon";
import { formatDateTime, localizeNumber } from "@/lib/i18n/format";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Gift cards",
  description: "Give Nabikaran credits as a gift: pay once, share a code, and they get SMS and WhatsApp reminders for their renewals.",
};

/** Gift cards: bought with money (QR / counter), shared as a code. Wallet credits are never transferable. */
export default async function GiftPage() {
  const { user, t, prefs } = await getRequestContext();
  const rules = await giftRules();
  const n = (v: number) => localizeNumber(v, prefs.lang);
  const appUrl = env.appUrl.replace(/\/$/, "");
  if (!user) {
    return (
      <div className="stack">
        <section className="welcome-hero">
          <div>
            <h1><Icon name="gift" size={26} /> {t("gift.heroTitle")}</h1>
            <p>{t("gift.heroText")}</p>
            <div className="row mt" style={{ gap: 8, flexWrap: "wrap" }}>
              <Link href="/login?next=/gift" className="btn btn-primary">{t("gift.signInToBuy")}</Link>
              <Link href="/login?next=/wallet%23redeem" className="btn btn-outline-light">{t("gift.haveCode")}</Link>
            </div>
          </div>
        </section>
        <div className="grid grid-3">
          {(["gift.how1", "gift.how2", "gift.how3"] as const).map((k, i) => (
            <div key={k} className="card"><span className="badge info">{n(i + 1)}</span><p className="mb-0 mt">{t(k)}</p></div>
          ))}
        </div>
      </div>
    );
  }
  const [gifts, qr] = await Promise.all([listMyGiftCards(user.id), getSetting("manual_qr")]);
  return (
    <div className="stack">
      <div className="page-head"><div><h1><Icon name="gift" size={22} /> {t("gift.title")}</h1><p>{t("gift.intro")}</p></div></div>
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <h2>{t("gift.buyTitle")}</h2>
          {rules.enabled ? <GiftBuy min={rules.min} max={rules.max} qrEnabled={qr.enabled} /> : <div className="alert warn">{t("gift.unavailable")}</div>}
        </section>
        <section className="card">
          <div className="card-head"><h2>{t("gift.mine")}</h2><Link href="/wallet#redeem" className="small">{t("gift.haveCode")} →</Link></div>
          {gifts.length === 0 ? <p className="muted mb-0">{t("gift.none")}</p> : (
            <div className="list">
              {gifts.map((g) => (
                <div key={g.id} className="list-item" style={{ flexWrap: "wrap" }}>
                  <span className="avatar-icon"><Icon name="gift" /></span>
                  <span className="grow">
                    <span className="title" style={{ display: "block" }}>{n(g.credits)} {t("common.credits")}{g.toName ? ` · ${t("gift.for")} ${g.toName}` : ""}</span>
                    {g.code && <span className="mono" style={{ display: "block", fontSize: 18, letterSpacing: 1 }}>{g.code}</span>}
                    <span className="meta">{formatDateTime(g.createdAt, prefs)}{g.usedAt ? ` · ${t("gift.usedOn")} ${formatDateTime(g.usedAt, prefs)}` : ""}</span>
                    {g.status === "active" && g.code && <div className="mt"><GiftShare code={g.code} credits={g.credits} toName={g.toName} message={g.message} appUrl={appUrl} /></div>}
                    {g.status === "pending" && g.requestId && <Link href={`/wallet/topup/${g.requestId}`} className="small">{t("gift.finishPay")} →</Link>}
                  </span>
                  <StatusBadge status={g.status === "active" ? "ready" : g.status} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
