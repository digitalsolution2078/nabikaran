import Link from "next/link";
import { listQueue, listSmsLog } from "@/lib/services/admin-console";
import { StatusBadge } from "@/components/StatusBadge";
import { ChannelBadge } from "@/components/ChannelBadge";
import { redactPhone } from "@/lib/phone";

export const dynamic = "force-dynamic";

const STATUSES = ["all", "scheduled", "awaiting_credits", "submitted", "delivered", "read", "failed", "unknown"] as const;
const CHANNELS = ["all", "sms", "whatsapp"] as const;
const QUEUE = new Set(["scheduled", "awaiting_credits"]);

/** Sending log across channels, plus the not-yet-sent queue. Phone numbers are masked. */
export default async function AdminMessages({ searchParams }: { searchParams: Promise<{ status?: string; channel?: string }> }) {
  const sp = await searchParams;
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "") ? sp.status! : "all";
  const channel = (CHANNELS as readonly string[]).includes(sp.channel ?? "") ? sp.channel! : "all";
  const ch = channel === "all" ? null : (channel as "sms" | "whatsapp");
  const isQueue = QUEUE.has(status);
  const [log, queue] = await Promise.all([
    isQueue ? Promise.resolve([]) : listSmsLog(status === "all" ? null : status, 200, undefined, ch),
    isQueue ? listQueue(status, ch) : Promise.resolve([]),
  ]);
  const href = (s: string, c: string) => `/admin/messages?status=${s}&channel=${c}`;
  return (
    <div className="stack">
      <nav className="admin-tabs" aria-label="Channel">{CHANNELS.map((c) => <Link key={c} href={href(status, c)} className={c === channel ? "active" : ""}>{c === "all" ? "All channels" : c === "sms" ? "SMS" : "WhatsApp"}</Link>)}</nav>
      <nav className="admin-tabs" aria-label="Status">{STATUSES.map((s) => <Link key={s} href={href(s, channel)} className={s === status ? "active" : ""}>{s.replace("_", " ")}</Link>)}</nav>
      <div className="table-wrap">
        {isQueue ? (
          <table>
            <thead><tr><th>Due</th><th>Channel</th><th>To</th><th>Reminder</th><th className="num">Credits</th><th>Status</th></tr></thead>
            <tbody>
              {queue.map((q) => (
                <tr key={q.id}>
                  <td className="nowrap small">{q.due_at_utc.replace("T", " ").slice(0, 16)} UTC</td>
                  <td><ChannelBadge channel={q.channel} /></td>
                  <td className="small"><Link href={`/admin/users/${q.user_id}`}>{redactPhone(q.phone_e164)}</Link></td>
                  <td>{q.label}</td>
                  <td className="num">{q.estimated_credits}</td>
                  <td><StatusBadge status={q.status} />{q.last_error ? <div className="small muted">{q.last_error}</div> : null}</td>
                </tr>
              ))}
              {queue.length === 0 && <tr><td colSpan={6} className="muted">Nothing in this queue.</td></tr>}
            </tbody>
          </table>
        ) : (
          <table>
            <thead><tr><th>Sent</th><th>Channel</th><th>To</th><th>Reminder</th><th>Status</th><th className="hide-mobile">Provider</th><th className="hide-mobile">Report</th></tr></thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.attempt_id}>
                  <td className="nowrap small">{l.request_at.replace("T", " ").slice(0, 16)} UTC</td>
                  <td><ChannelBadge channel={l.channel} /></td>
                  <td className="small"><Link href={`/admin/users/${l.user_id}`}>{redactPhone(l.phone_e164)}</Link></td>
                  <td>{l.label}</td>
                  <td><StatusBadge status={l.status} />{l.error_text ? <div className="small muted">{l.error_text}</div> : null}{l.refunded_at ? <div className="small">refunded</div> : null}</td>
                  <td className="small hide-mobile">{l.provider} · {l.api_state}{l.provider_message_id ? <><br /><span className="mono">{l.provider_message_id.slice(0, 28)}</span></> : null}</td>
                  <td className="small hide-mobile">{l.reported_status ?? "—"}{l.delivered_at ? <><br />delivered {l.delivered_at.slice(0, 16).replace("T", " ")}</> : null}{l.read_at ? <><br />read {l.read_at.slice(0, 16).replace("T", " ")}</> : null}</td>
                </tr>
              ))}
              {log.length === 0 && <tr><td colSpan={7} className="muted">No messages match.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
