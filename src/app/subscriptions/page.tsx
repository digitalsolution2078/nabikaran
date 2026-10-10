import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { isPro } from "@/lib/services/plans";
import { listSubscriptions } from "@/lib/services/subscriptions";
import { emailStatus } from "@/lib/services/email-auth";
import { getEmailProvider } from "@/lib/providers/email";
import { formatDate, localizeNumber } from "@/lib/i18n/format";
import { SubscriptionForm } from "@/components/SubscriptionForm";
import { ChannelBadges } from "@/components/ChannelBadge";
import { Icon } from "@/components/Icon";
import type { MessageKey } from "@/lib/i18n/dict";

export const dynamic = "force-dynamic";
export const metadata = { title: "Subscriptions" };

export default async function SubscriptionsPage() {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login?next=/subscriptions");
  // Pro feature: Basic accounts go to the Pro page instead.
  if (!(await isPro(user.id))) redirect("/pro");
  const [data, email, provider] = await Promise.all([listSubscriptions(user.id), emailStatus(user.id), getEmailProvider().catch(() => null)]);
  const n = (x: number, d = 0) => localizeNumber(Number(x.toFixed(d)), prefs.lang);
  return (
    <div className="stack">
      <div className="page-head"><h1><Icon name="repeat" /> {t("sub.title")}</h1></div>
      <p className="muted" style={{ marginTop: -8 }}>{t("sub.intro")}</p>

      <div className="grid grid-3">
        <div className="stat"><div className="label">{t("sub.count")}</div><div className="value">{n(data.items.length)}</div></div>
        <div className="stat"><div className="label">{t("sub.monthly")}</div><div className="value" style={{ fontSize: 20 }}>{data.totals.length ? data.totals.map((x) => `${x.currency} ${n(x.monthly, x.currency === "NPR" ? 0 : 2)}`).join(" · ") : "—"}</div></div>
        <div className="stat"><div className="label">{t("sub.yearly")}</div><div className="value" style={{ fontSize: 20 }}>{data.totals.length ? data.totals.map((x) => `${x.currency} ${n(x.yearly, x.currency === "NPR" ? 0 : 2)}`).join(" · ") : "—"}</div></div>
      </div>
      {data.totals.length > 1 && <p className="hint" style={{ marginTop: -8 }}>{t("sub.estimate")}</p>}

      {data.upcoming.length > 0 && (
        <section className="card">
          <h2>{t("sub.upcoming")}</h2>
          <div className="list sub-list">
            {data.upcoming.map((s) => (
              <Link href={`/renewals/${s.id}`} key={s.id} className="list-item">
                <span className="grow"><strong>{s.label}</strong><br /><span className="small muted">{formatDate(s.nextAt, prefs)}{s.paymentMethod ? ` · ${s.paymentMethod}` : ""}</span></span>
                {s.amount !== null && <span className="sub-amt">{s.currency} {n(s.amount, 2)}</span>}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h2>{t("sub.add")}</h2>
        <SubscriptionForm emailAvailable={email.verified && Boolean(provider)} />
      </section>

      <section className="card">
        <h2>{t("sub.title")}</h2>
        {data.items.length === 0 ? <p className="muted mb-0">{t("sub.none")}</p> : (
          <div className="list sub-list">
            {data.items.map((s) => (
              <Link href={`/renewals/${s.id}`} key={s.id} className="list-item">
                <span className="grow">
                  <strong>{s.label}</strong> {s.status !== "active" && <span className="badge warn">{s.status}</span>}<br />
                  <span className="small muted">
                    {s.cycleMonths ? t(`sub.cycle.${s.cycleMonths}` as MessageKey) : "—"} · {t("sub.next", { date: formatDate(s.nextAt, prefs) })}
                    {s.paymentMethod ? ` · ${s.paymentMethod}` : ""}{s.autoRenew ? ` · ${t("sub.autoRenew")}` : ""}
                  </span>
                </span>
                <span className="row" style={{ gap: 8 }}>
                  <ChannelBadges channels={s.channels} />
                  {s.amount !== null && <span className="sub-amt">{s.currency} {n(s.amount, 2)}</span>}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
