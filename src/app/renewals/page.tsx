import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { listRenewalsForUser, recordSummary, type RenewalFilter } from "@/lib/services/customer-summary";
import { StatusBadge } from "@/components/StatusBadge";
import { ChannelBadges } from "@/components/ChannelBadge";
import { Icon, iconForCategory, iconForGroup } from "@/components/Icon";
import { formatDate, formatDateTime, daysUntil, localizeNumber } from "@/lib/i18n/format";
import { categoryName } from "@/lib/categories";
import type { MessageKey } from "@/lib/i18n/dict";
import { businessName, listClients } from "@/lib/services/clients";
import { recordUsage } from "@/lib/services/limits";
import { listGroups } from "@/lib/services/groups";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reminders" };

const FILTERS: RenewalFilter[] = ["active", "due", "awaiting", "expired", "paused", "all"];
/** "My records" type groups (category groups). */
const REC_GROUPS = ["vehicle", "personal", "insurance", "business", "occasions", "custom"];

export default async function RenewalsPage({ searchParams }: { searchParams: Promise<{ filter?: string; status?: string; q?: string; group?: string; imported?: string; client?: string; cat?: string; remind?: string }> }) {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login?next=/renewals");
  const sp = await searchParams;
  const raw = sp.filter ?? sp.status ?? "active";
  const filter: RenewalFilter = (FILTERS as string[]).includes(raw) ? (raw as RenewalFilter) : "active";
  const q = (sp.q ?? "").slice(0, 60);
  const groups = await listGroups(user.id);
  const group = groups.find((g) => g.id === sp.group) ?? null;
  const imported = Number(sp.imported ?? 0);
  const clients = (await businessName(user.id)) ? await listClients(user.id) : [];
  const client = clients.find((c) => c.id === sp.client) ?? null;
  const cat = REC_GROUPS.includes(sp.cat ?? "") ? sp.cat! : null;
  const remindOff = sp.remind === "off";
  const [rows, sum, usage] = await Promise.all([
    listRenewalsForUser(user.id, { filter, q, groupId: group?.id ?? null, clientId: client?.id ?? null, categoryGroup: cat, remindersOff: remindOff }),
    recordSummary(user.id),
    recordUsage(user.id),
  ]);
  const pct = Math.min(100, Math.round((usage.used / Math.max(1, usage.limit)) * 100));
  const n = (v: number) => localizeNumber(v, prefs.lang);
  const label: Record<RenewalFilter, string> = {
    active: t("status.active"), due: t("dash.dueSoon"), awaiting: t("dash.awaiting"), expired: t("dash.expired"), paused: t("status.paused"), all: t("rem.filterAll"),
  };
  const other = { ...prefs, date: prefs.date === "BS" ? "AD" : "BS" } as const;
  const qs = (f: string, g: string | null = group?.id ?? null, c: string | null = client?.id ?? null, k: string | null = cat, off = remindOff) =>
    `/renewals?filter=${f}${q ? `&q=${encodeURIComponent(q)}` : ""}${g ? `&group=${g}` : ""}${c ? `&client=${c}` : ""}${k ? `&cat=${k}` : ""}${off ? "&remind=off" : ""}`;

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>{client ? client.name : group ? group.name : t("rem.title")}</h1>{(group || client) && <p><Link href="/renewals">← {t("rem.title")}</Link>{client && <> · <Link href="/clients">{t("nav.clients")}</Link></>}</p>}</div>
        <div className="row">
          <Link className="btn btn-secondary" href={group ? `/renewals/import?group=${group.id}` : "/renewals/import"}><Icon name="upload" size={16} /> {t("imp.short")}</Link>
          <Link className="btn btn-primary" href={client ? `/renewals/new?client=${client.id}` : group ? `/renewals/new?group=${group.id}` : "/renewals/new"}><Icon name="plus" /> {t("rem.add")}</Link>
        </div>
      </div>

      {imported > 0 && <div className="alert ok"><Icon name="check" /> <span>{t("imp.done", { n: n(imported) })}</span></div>}

      {!group && !client && (
        <section className="records-overview" aria-label={t("rec.overview")}>
          <div className="rec-usage">
            <div className="row between" style={{ gap: 8 }}>
              <span className="small"><strong>{n(usage.used)}</strong> / {n(usage.limit)} {t("rec.records")}</span>
              {!usage.pro && <Link href="/pro" className="small">{t("rec.proLimit", { n: n(usage.proLimit) })} →</Link>}
            </div>
            <div className={`rec-meter ${pct >= 90 ? "full" : pct >= 75 ? "high" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={usage.limit} aria-valuenow={usage.used} aria-label={t("rec.records")}><span style={{ width: `${pct}%` }} /></div>
          </div>
          <div className="rec-stats">
            <Link href={qs("active", null, null, null, false)} className="rec-stat ok"><span className="v">{n(sum.valid + sum.expiring)}</span><span className="l">{t("rec.valid")}</span></Link>
            <Link href={qs("due", null, null, null, false)} className={`rec-stat warn ${sum.expiring ? "" : "zero"}`}><span className="v">{n(sum.expiring)}</span><span className="l">{t("rec.expiring")}</span></Link>
            <Link href={qs("expired", null, null, null, false)} className={`rec-stat bad ${sum.expired ? "" : "zero"}`}><span className="v">{n(sum.expired)}</span><span className="l">{t("rec.expired")}</span></Link>
            <Link href={qs("all", null, null, null, true)} className={`rec-stat ${remindOff ? "on" : ""}`}><span className="v">{n(sum.remindersOff)}</span><span className="l">{t("rec.remindersOff")}</span></Link>
          </div>
          {sum.total > 0 && (
            <nav className="rec-groups" aria-label={t("rec.byType")}>
              <Link href={qs(filter, null, null, null)} className="chip" aria-pressed={!cat}>{t("grp.all")} <span className="muted">{n(sum.total)}</span></Link>
              {REC_GROUPS.filter((g) => sum.byGroup[g]).map((g) => (
                <Link key={g} href={qs(filter, null, null, g)} className="chip" aria-pressed={cat === g}><Icon name={iconForGroup(g)} size={14} /> {t(`rec.grp.${g}` as MessageKey)} <span className="muted">{n(sum.byGroup[g])}</span></Link>
              ))}
              {usage.pro ? <Link href="/insights" className="chip"><Icon name="chart" size={14} /> {t("rec.spending")}</Link> : null}
            </nav>
          )}
        </section>
      )}

      <nav className="group-chips" aria-label={t("grp.title")}>
        <Link href={qs(filter, null)} className="chip" aria-pressed={!group}>{t("grp.all")}</Link>
        {groups.map((g) => <Link key={g.id} href={qs(filter, g.id)} className="chip" aria-pressed={group?.id === g.id}><Icon name={g.kind === "custom" ? "folder" : "gift"} size={14} /> {g.name} <span className="muted">{n(g.active)}</span></Link>)}
        <Link href="/renewals/groups" className="chip"><Icon name={groups.length ? "settings" : "plus"} size={14} /> {groups.length ? t("grp.manage") : t("grp.new")}</Link>
      </nav>

      <form className="search-row" role="search" action="/renewals">
        <input type="hidden" name="filter" value={filter} />
        {group && <input type="hidden" name="group" value={group.id} />}
        {client && <input type="hidden" name="client" value={client.id} />}
        <div className="input-affix"><span><Icon name="search" size={16} /></span><input type="search" name="q" defaultValue={q} placeholder={t("rem.searchPlaceholder")} aria-label={t("rem.searchPlaceholder")} /></div>
        <button className="btn btn-secondary" type="submit">{t("rem.search")}</button>
      </form>

      <nav className="admin-tabs" aria-label="Filter">
        {FILTERS.map((f) => <Link key={f} href={qs(f)} className={filter === f ? "active" : ""} aria-current={filter === f ? "page" : undefined}>{label[f]}</Link>)}
      </nav>

      {filter === "awaiting" && rows.length > 0 && (
        <div className="alert warn"><Icon name="alert" /> <span>{t("dash.awaitingCredits")} <Link href="/wallet">{t("lock.cta")} →</Link></span></div>
      )}

      {rows.length === 0 ? (
        <div className="card empty">
          <div className="icon-wrap"><Icon name="bell" size={26} /></div>
          <p>{q ? t("rem.noMatch") : t("rem.empty")}</p>
          <Link href="/renewals/new" className="btn btn-primary">{t("rem.add")}</Link>
        </div>
      ) : (
        <ul className="renewal-list">
          {rows.map((r) => {
            const d = daysUntil(r.expiryAt);
            return (
              <li key={r.id}>
                <Link href={`/renewals/${r.id}`} className="renewal-row">
                  <span className="avatar-icon"><Icon name={iconForCategory(r.category)} /></span>
                  <span className="rr-main">
                    <span className="rr-title">{r.label}{r.repeatYearly && <span className="muted" title={t("grp.repeatYearly")}> ↻</span>}{!group && r.groupName && <span className="rr-group">{r.groupName}</span>}{!client && r.clientName && <span className="rr-group rr-client"><Icon name="users" size={12} /> {r.clientName}</span>}</span>
                    <span className="rr-meta">{categoryName(r.category, prefs.lang)}{r.familyMemberLabel ? ` · ${r.familyMemberLabel}` : ""}</span>
                    <span className="rr-meta">
                      <strong>{formatDate(r.expiryAt, prefs)}</strong> · {formatDate(r.expiryAt, other)}
                    </span>
                    <span className="rr-meta">
                      {r.remindersOn ? <><ChannelBadges channels={r.channels} />{" "}
                      {r.nextAt ? <>{t("rem.next")}: {formatDateTime(r.nextAt, prefs)}</> : t("rem.noNext")}</> : <span className="badge"><Icon name="file" size={12} /> {t("rec.recordOnlyBadge")}</span>}
                      {r.heldCredits > 0 && <> · {n(r.heldCredits)} {t("common.credits")}</>}
                    </span>
                  </span>
                  <span className="rr-side">
                    <span className={`days-pill ${d < 0 ? "past" : d <= 30 ? "soon" : ""}`}>{d < 0 ? t("dash.overdue") : d === 0 ? t("dash.today") : d === 1 ? t("dash.dayLeft") : t("dash.daysLeft", { n: n(d) })}</span>
                    {r.awaitingMessages > 0 ? <StatusBadge status="awaiting_credits" /> : <StatusBadge status={r.expired && r.status === "active" ? "expired" : r.status} />}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
