import type { MessageKey } from "@/lib/i18n/dict";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { webPrincipal } from "@/lib/core/principal";
import { getReminder, listRenewalHistory as listRenewals } from "@/lib/core/reminders";
import { isPro } from "@/lib/services/plans";
import { googleTemplateLink } from "@/lib/services/calendar";
import { MarkRenewed } from "@/components/MarkRenewed";
import { ProBadge } from "@/components/Shell";
import { StatusBadge } from "@/components/StatusBadge";
import { ChannelBadge, ChannelBadges } from "@/components/ChannelBadge";
import { listRenewalHistory } from "@/lib/services/customer-summary";
import { RenewalActions } from "@/components/RenewalActions";
import { Icon, iconForCategory } from "@/components/Icon";
import { formatDate, formatDateTime, otherCalendar, localizeNumber, daysUntil, offsetLabel } from "@/lib/i18n/format";
import { categoryName } from "@/lib/categories";
import { getGroup } from "@/lib/services/groups";

export const dynamic = "force-dynamic";

export default async function RenewalDetail({ params }: { params: Promise<{ id: string }> }) {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login");
  const { id } = await params;
  const r = await getReminder(webPrincipal(user), id).catch(() => null);
  if (!r) notFound();
  const d = daysUntil(r.expiry.utc);
  const [history, group, pro] = await Promise.all([listRenewalHistory(user.id, r.id), r.groupId ? getGroup(user.id, r.groupId) : Promise.resolve(null), isPro(user.id)]);
  const renewals = pro ? (await listRenewals(user.id)).filter((h) => h.renewalId === r.id) : [];
  // Suggested new expiry for "Mark as renewed": one year after the current date, in the reminder's calendar.
  const cur = (r.inputDate ?? r.expiry.ad).split("-").map(Number);
  const suggestedNext = cur.length === 3 ? `${cur[0] + 1}-${String(cur[1]).padStart(2, "0")}-${String(cur[2]).padStart(2, "0")}` : "";
  const groupName = group?.name ?? null;
  const n = (v: number) => localizeNumber(v, prefs.lang);
  const pending = r.jobs.filter((j) => ["scheduled", "planned", "awaiting_credits", "sending", "unknown"].includes(j.status));
  const awaiting = r.jobs.filter((j) => j.status === "awaiting_credits");
  const lifecycle = r.status === "paused" ? "paused" : r.status === "cancelled" ? "cancelled" : d < 0 ? "expired" : "active";
  const pendingCredits = pending.reduce((x, j) => x + j.estimatedCredits, 0);
  return (
    <div className="stack">
      <Link href="/renewals" className="small">← {t("rem.title")}</Link>
      <div className="card">
        <div className="row between">
          <span className="row"><span className="avatar-icon"><Icon name={iconForCategory(r.category)} /></span><span><h1 className="mb-0">{r.label}</h1><span className="small muted">{categoryName(r.category, prefs.lang)}{r.familyMemberLabel ? ` · ${r.familyMemberLabel}` : ""}{groupName ? ` · ${groupName}` : ""}{r.repeatYearly ? ` · ↻ ${t("grp.repeatYearly")}` : r.repeatMonths ? ` · ↻ ${t(`sub.cycle.${r.repeatMonths}` as MessageKey)}` : ` · ${t("rem.cycle")} ${n(r.cycleNo)}`}{r.subscription?.amount != null ? ` · ${r.subscription.currency} ${r.subscription.amount}` : ""}{r.subscription?.paymentMethod ? ` · ${r.subscription.paymentMethod}` : ""}</span></span></span>
          <StatusBadge status={lifecycle} />
        </div>
        <div className="stat-grid mt">
          <div className="stat"><div className="label">{t("rem.expires")}</div><div className="value value-sm">{formatDate(r.expiry.utc, prefs)}</div><div className="sub">{otherCalendar(r.expiry.utc, prefs)} · {r.expiry.local.slice(11)} NPT</div></div>
          <div className="stat"><div className="label">{t("rem.daysRemaining")}</div><div className="value value-sm">{d < 0 ? t("dash.overdue") : d === 0 ? t("dash.today") : d === 1 ? t("dash.dayLeft") : t("dash.daysLeft", { n: n(d) })}</div></div>
          <div className="stat"><div className="label">{t("rem.channel")}</div><div className="value value-sm"><ChannelBadges channels={r.channels} /></div><div className="sub">{n(pending.length)} {t("rem.pendingMsgs")} · {n(pendingCredits)} {t("common.credits")}</div></div>
        </div>
        <div className="mt row">
          {r.status !== "cancelled" && <Link href={`/renewals/${r.id}/edit`} className="btn btn-primary btn-sm"><Icon name="edit" size={14} /> {t("rem.editBtn")}</Link>}
          <RenewalActions id={r.id} status={r.status} />
          {pro && r.status === "active" && (
            <a className="btn btn-ghost btn-sm" href={googleTemplateLink({ label: r.label, expiryUtc: r.expiry.utc, details: `Nabikaran reminder` })} target="_blank" rel="noopener noreferrer"><Icon name="calendar" size={14} /> {t("cal.addOne")}</a>
          )}
          {pro && r.status === "active" && !r.linkedTo && (
            <MarkRenewed id={r.id} repeats={r.repeatYearly || Boolean(r.repeatMonths)} calendar={r.inputCalendar} suggestedNext={suggestedNext} currency={r.subscription?.currency ?? "NPR"} />
          )}
        </div>
        {r.linkedTo && <p className="hint mb-0 mt"><Icon name="info" size={12} /> <Link href={`/renewals/${r.linkedTo}`}>{t("sub.cancelNotice")} →</Link></p>}
      </div>

      {renewals.length > 0 && (
        <section className="card">
          <h2>{t("hist.title")} <ProBadge small /></h2>
          <div className="list">
            {renewals.map((h) => (
              <div key={h.id} className="list-item">
                <span className="grow">{formatDate(`${h.renewedOn}T06:15:00Z`, prefs)} · <span className="small muted">{h.source === "auto" ? t("hist.auto") : t("hist.manual")}{h.note ? ` · ${h.note}` : ""}</span></span>
                {h.amount !== null && <span className="sub-amt">{h.currency} {n(h.amount)}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {lifecycle === "expired" && (
        <div className="alert info"><Icon name="info" /> <span>{t("rem.expiredHint")} <Link href={`/renewals/${r.id}/edit`}>{t("rem.editBtn")} →</Link></span></div>
      )}
      {awaiting.length > 0 && (
        <div className="alert warn"><Icon name="alert" /> <span>{t("rem.awaitingHint", { n: n(awaiting.length) })} <Link href={`/wallet?amount=${Math.max(20, awaiting.reduce((x, j) => x + j.estimatedCredits, 0))}`} className="btn btn-accent btn-sm">{t("lock.cta")}</Link></span></div>
      )}

      <section className="card">
        <h2>{t("rem.scheduled")}</h2>
        {pending.length === 0 ? <p className="muted mb-0">{t("msg.nonePending")}</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t("rem.sendAt")}</th><th>{t("rem.channel")}</th><th className="num">{t("rem.credits")}</th><th>{t("common.status")}</th></tr></thead>
              <tbody>
                {pending.map((j) => (
                  <tr key={j.id}>
                    <td>{formatDateTime(j.due.utc, prefs)}<br /><span className="small muted">{offsetLabel(j.offsetMinutes, prefs.lang)}</span></td>
                    <td><ChannelBadge channel={j.channel} /></td>
                    <td className="num">{n(j.estimatedCredits)}</td>
                    <td><StatusBadge status={j.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>{t("msg.history")}</h2>
        {history.length === 0 ? <p className="muted mb-0">{t("dash.noneRecent")}</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t("rem.sendAt")}</th><th>{t("rem.channel")}</th><th className="num">{t("rem.credits")}</th><th>{t("common.status")}</th></tr></thead>
              <tbody>
                {history.map((m) => (
                  <tr key={m.id}>
                    <td>{formatDateTime(m.dueAt, prefs)}<br /><span className="small muted">{offsetLabel(m.offsetMinutes, prefs.lang)}</span></td>
                    <td><ChannelBadge channel={m.channel} /></td>
                    <td className="num">{m.status === "failed" ? "0" : n(m.credits)}</td>
                    <td><StatusBadge status={m.status} />{m.lastError && m.status === "failed" && <div className="small muted">{m.lastError}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint mt mb-0">{t("rem.deliveryNote")}</p>
      </section>

      {r.notes && <section className="card"><h2>{t("rem.notes")}</h2><p className="mb-0" style={{ whiteSpace: "pre-wrap" }}>{r.notes}</p></section>}

    </div>
  );
}
