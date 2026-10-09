import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { webPrincipal } from "@/lib/core/principal";
import { getReminder } from "@/lib/core/reminders";
import { StatusBadge } from "@/components/StatusBadge";
import { RenewalActions } from "@/components/RenewalActions";
import { Icon, iconForCategory } from "@/components/Icon";
import { formatDate, formatDateTime, otherCalendar, localizeNumber, daysUntil, offsetLabel } from "@/lib/i18n/format";
import { categoryName } from "@/lib/categories";

export const dynamic = "force-dynamic";

export default async function RenewalDetail({ params }: { params: Promise<{ id: string }> }) {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login");
  const { id } = await params;
  const r = await getReminder(webPrincipal(user), id).catch(() => null);
  if (!r) notFound();
  const d = daysUntil(r.expiry.utc);
  return (
    <div className="stack">
      <Link href="/renewals" className="small">← {t("rem.title")}</Link>
      <div className="card">
        <div className="row between">
          <span className="row"><span className="avatar-icon"><Icon name={iconForCategory(r.category)} /></span><span><h1 className="mb-0">{r.label}</h1><span className="small muted">{categoryName(r.category, prefs.lang)}{r.familyMemberLabel ? ` · ${r.familyMemberLabel}` : ""} · {t("rem.cycle")} {localizeNumber(r.cycleNo, prefs.lang)}</span></span></span>
          <StatusBadge status={r.status} />
        </div>
        <div className="grid grid-3 mt">
          <div className="stat"><div className="label">{t("rem.expires")}</div><div className="value" style={{ fontSize: 20 }}>{formatDate(r.expiry.utc, prefs)}</div><div className="sub">{otherCalendar(r.expiry.utc, prefs)} · {r.expiry.local.slice(11)} NPT</div></div>
          <div className="stat"><div className="label">{t("dash.expiringSoon")}</div><div className="value" style={{ fontSize: 20 }}>{d < 0 ? t("dash.overdue") : d === 0 ? t("dash.today") : t("dash.daysLeft", { n: localizeNumber(d, prefs.lang) })}</div></div>
          <div className="stat"><div className="label">{t("rem.thisCycle")}</div><div className="value" style={{ fontSize: 20 }}>{t("rem.smsCount", { n: localizeNumber(r.jobs.length, prefs.lang) })}</div></div>
        </div>
        <div className="mt row">
          {r.status !== "cancelled" && <Link href={`/renewals/${r.id}/edit`} className="btn btn-primary btn-sm"><Icon name="edit" size={14} /> {t("rem.editBtn")}</Link>}
          <RenewalActions id={r.id} status={r.status} />
        </div>
      </div>

      <section className="card">
        <h2>{t("rem.thisCycle")}</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t("rem.sendAt")}</th><th className="num">{t("rem.credits")}</th><th>{t("common.status")}</th></tr></thead>
            <tbody>
              {r.jobs.map((j) => (
                <tr key={j.id}>
                  <td>{formatDateTime(j.due.utc, prefs)}<br /><span className="small muted">{offsetLabel(j.offsetMinutes, prefs.lang)}</span></td>
                  <td className="num">{localizeNumber(j.estimatedCredits, prefs.lang)}</td>
                  <td><StatusBadge status={j.status} />{j.lastError && j.status === "failed" && <div className="small muted">{j.lastError}</div>}</td>
                </tr>
              ))}
              {r.jobs.length === 0 && <tr><td colSpan={3} className="muted">{t("common.none")}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {r.notes && <section className="card"><h2>{t("rem.notes")}</h2><p className="mb-0" style={{ whiteSpace: "pre-wrap" }}>{r.notes}</p></section>}

    </div>
  );
}
