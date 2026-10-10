import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { isPro } from "@/lib/services/plans";
import { listRenewalHistory } from "@/lib/core/reminders";
import { categoryName } from "@/lib/categories";
import { formatDate, localizeNumber } from "@/lib/i18n/format";
import { Icon } from "@/components/Icon";
import { ProBadge } from "@/components/Shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Renewal history" };

export default async function HistoryPage() {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login?next=/history");
  if (!(await isPro(user.id))) redirect("/pro");
  const rows = await listRenewalHistory(user.id);
  return (
    <div className="stack">
      <div className="page-head"><h1><Icon name="clock" /> {t("hist.title")} <ProBadge small /></h1></div>
      <p className="muted" style={{ marginTop: -8 }}>{t("hist.intro")}</p>
      <section className="card">
        {rows.length === 0 ? <p className="muted mb-0">{t("hist.none")}</p> : (
          <div className="list">
            {rows.map((h) => (
              <div key={h.id} className="list-item">
                <span className="grow">
                  {h.renewalId ? <Link href={`/renewals/${h.renewalId}`}><strong>{h.label}</strong></Link> : <strong>{h.label}</strong>}
                  <span className="small muted"> · {categoryName(h.category, prefs.lang)}</span><br />
                  <span className="small muted">
                    {formatDate(`${h.renewedOn}T06:15:00Z`, prefs)} · {h.source === "auto" ? t("hist.auto") : t("hist.manual")}
                    {h.nextDue ? ` · ${t("hist.next", { date: formatDate(h.nextDue, prefs) })}` : ""}{h.note ? ` · ${h.note}` : ""}
                  </span>
                </span>
                {h.amount !== null && <span className="sub-amt">{h.currency} {localizeNumber(h.amount, prefs.lang)}</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
