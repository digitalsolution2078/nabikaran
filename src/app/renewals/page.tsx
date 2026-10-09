import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { webPrincipal } from "@/lib/core/principal";
import { listReminders } from "@/lib/core/reminders";
import { StatusBadge } from "@/components/StatusBadge";
import { Icon, iconForCategory } from "@/components/Icon";
import { formatDate, otherCalendar, daysUntil, localizeNumber } from "@/lib/i18n/format";
import { categoryName } from "@/lib/categories";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reminders" };

export default async function RenewalsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login");
  const { status } = await searchParams;
  const filter = status === "paused" || status === "cancelled" ? status : status === "all" ? "all" : "active";
  const { reminders } = await listReminders(webPrincipal(user), { status: filter, limit: 50 });
  const tabs: [string, string][] = [["active", t("status.active")], ["paused", t("status.paused")], ["cancelled", t("status.cancelled")], ["all", "All / सबै"]];
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>{t("rem.title")}</h1></div>
        <Link className="btn btn-primary" href="/renewals/new"><Icon name="plus" /> {t("rem.add")}</Link>
      </div>
      <div className="segmented" role="tablist">
        {tabs.map(([k, label]) => (
          <Link key={k} href={`/renewals?status=${k}`} role="tab" aria-selected={filter === k} className="btn btn-sm" style={{ background: filter === k ? "var(--surface)" : "transparent", boxShadow: filter === k ? "var(--shadow-sm)" : "none", color: "var(--fg)" }}>{label}</Link>
        ))}
      </div>
      {reminders.length === 0 ? (
        <div className="card empty">
          <div className="icon-wrap"><Icon name="bell" size={26} /></div>
          <p>{t("rem.empty")}</p>
          <Link href="/renewals/new" className="btn btn-primary">{t("rem.add")}</Link>
        </div>
      ) : (
        <div className="grid grid-2">
          {reminders.map((r) => {
            const d = daysUntil(r.expiry.utc);
            const sent = r.jobs.filter((j) => j.status !== "cancelled").length;
            return (
              <Link key={r.id} href={`/renewals/${r.id}`} className="card" style={{ color: "inherit", textDecoration: "none", display: "block" }}>
                <div className="row between">
                  <span className="row"><span className="avatar-icon"><Icon name={iconForCategory(r.category)} /></span><span><strong>{r.label}</strong><br /><span className="small muted">{categoryName(r.category, prefs.lang)}{r.familyMemberLabel ? ` · ${r.familyMemberLabel}` : ""}</span></span></span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="row between mt">
                  <span>
                    <span className="small muted">{t("rem.expires")}</span><br />
                    <strong>{formatDate(r.expiry.utc, prefs)}</strong> <span className="small muted">({otherCalendar(r.expiry.utc, prefs)})</span>
                  </span>
                  <span className={`days-pill ${d < 0 ? "past" : d <= 30 ? "soon" : ""}`}>{d < 0 ? t("dash.overdue") : d === 0 ? t("dash.today") : t("dash.daysLeft", { n: localizeNumber(d, prefs.lang) })}</span>
                </div>
                <div className="small muted mt">{t("rem.smsCount", { n: localizeNumber(sent, prefs.lang) })}</div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
