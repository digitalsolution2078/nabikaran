import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/lib/i18n/server";
import { listCustomerMessages } from "@/lib/services/customer-summary";
import { StatusBadge } from "@/components/StatusBadge";
import { ChannelBadge } from "@/components/ChannelBadge";
import { Icon } from "@/components/Icon";
import { formatDateTime, localizeNumber, offsetLabel } from "@/lib/i18n/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Messages" };

/** Every scheduled and sent reminder message, by channel. */
export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { user, t, prefs } = await getRequestContext();
  if (!user) redirect("/login?next=/messages");
  const { tab } = await searchParams;
  const kind = tab === "history" ? "history" : "pending";
  const rows = await listCustomerMessages(user.id, kind);
  const awaiting = rows.filter((r) => r.status === "awaiting_credits");
  return (
    <div className="stack">
      <div className="page-head"><div><h1>{t("msg.title")}</h1></div></div>
      <nav className="admin-tabs" aria-label={t("msg.title")}>
        <Link href="/messages" className={kind === "pending" ? "active" : ""}>{t("msg.pending")}</Link>
        <Link href="/messages?tab=history" className={kind === "history" ? "active" : ""}>{t("msg.history")}</Link>
      </nav>
      {awaiting.length > 0 && (
        <div className="alert warn"><Icon name="alert" /> <span>{t("dash.awaitingCredits")} <Link href="/wallet">{t("lock.cta")} →</Link></span></div>
      )}
      {rows.length === 0 ? (
        <div className="card empty"><div className="icon-wrap"><Icon name="message" size={26} /></div><p>{kind === "pending" ? t("msg.nonePending") : t("dash.noneRecent")}</p></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t("rem.sendAt")}</th><th>{t("rem.label")}</th><th>{t("rem.channel")}</th><th className="num">{t("rem.credits")}</th><th>{t("common.status")}</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td className="nowrap">{formatDateTime(m.dueAt, prefs)}<br /><span className="small muted">{offsetLabel(m.offsetMinutes, prefs.lang)}</span></td>
                  <td><Link href={`/renewals/${m.renewalId}`}>{m.label}</Link></td>
                  <td><ChannelBadge channel={m.channel} /></td>
                  <td className="num">{localizeNumber(m.credits, prefs.lang)}</td>
                  <td><StatusBadge status={m.status} />{m.lastError && m.status === "failed" && <div className="small muted">{m.lastError}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
