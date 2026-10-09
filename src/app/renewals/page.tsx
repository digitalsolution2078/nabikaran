import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { listRenewalsForUser, type RenewalFilter } from "@/lib/services/customer-summary";
import { StatusBadge } from "@/components/StatusBadge";
import { ChannelBadges } from "@/components/ChannelBadge";
import { Icon, iconForCategory } from "@/components/Icon";
import { formatDate, formatDateTime, daysUntil, localizeNumber } from "@/lib/i18n/format";
import { categoryName } from "@/lib/categories";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reminders" };

const FILTERS: RenewalFilter[] = ["active", "due", "awaiting", "expired", "paused", "all"];

export default async function RenewalsPage({ searchParams }: { searchParams: Promise<{ filter?: string; status?: string; q?: string }> }) {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login?next=/renewals");
  const sp = await searchParams;
  const raw = sp.filter ?? sp.status ?? "active";
  const filter: RenewalFilter = (FILTERS as string[]).includes(raw) ? (raw as RenewalFilter) : "active";
  const q = (sp.q ?? "").slice(0, 60);
  const rows = await listRenewalsForUser(user.id, { filter, q });
  const n = (v: number) => localizeNumber(v, prefs.lang);
  const label: Record<RenewalFilter, string> = {
    active: t("status.active"), due: t("dash.dueSoon"), awaiting: t("dash.awaiting"), expired: t("dash.expired"), paused: t("status.paused"), all: t("rem.filterAll"),
  };
  const other = { ...prefs, date: prefs.date === "BS" ? "AD" : "BS" } as const;
  const qs = (f: string) => `/renewals?filter=${f}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>{t("rem.title")}</h1></div>
        <Link className="btn btn-primary" href="/renewals/new"><Icon name="plus" /> {t("rem.add")}</Link>
      </div>

      <form className="search-row" role="search" action="/renewals">
        <input type="hidden" name="filter" value={filter} />
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
                    <span className="rr-title">{r.label}</span>
                    <span className="rr-meta">{categoryName(r.category, prefs.lang)}{r.familyMemberLabel ? ` · ${r.familyMemberLabel}` : ""}</span>
                    <span className="rr-meta">
                      <strong>{formatDate(r.expiryAt, prefs)}</strong> · {formatDate(r.expiryAt, other)}
                    </span>
                    <span className="rr-meta">
                      <ChannelBadges channels={r.channels} />{" "}
                      {r.nextAt ? <>{t("rem.next")}: {formatDateTime(r.nextAt, prefs)}</> : t("rem.noNext")}
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
