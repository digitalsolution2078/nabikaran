import Link from "next/link";
import { getMetrics } from "@/lib/services/admin";
import { getOverview } from "@/lib/services/admin-console";
import { getOps, type ChannelOps } from "@/lib/services/ops";
import { listClientsForAdmin } from "@/lib/oauth/tokens";
import { AdminClients } from "@/components/AdminClients";
import { Icon } from "@/components/Icon";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { formatPhoneLocal } from "@/lib/phone";

export const dynamic = "force-dynamic";

type IconName = Parameters<typeof Icon>[0]["name"];

function Stat({ label, value, sub, icon, tone, href }: { label: string; value: string | number; sub?: string; icon: IconName; tone?: "orange" | "yellow" | "bad"; href?: string }) {
  const body = (
    <>
      <div className="label"><span className={`icon-chip ${tone === "bad" ? "orange" : tone ?? ""}`}><Icon name={icon} size={16} /></span>{label}</div>
      <div className={`value ${tone === "bad" && value !== 0 ? "text-bad" : ""}`}>{typeof value === "number" ? value.toLocaleString("en-IN") : value}</div>
      {sub && <div className="sub">{sub}</div>}
    </>
  );
  return href ? <Link href={href} className="stat stat-link">{body}</Link> : <div className="stat">{body}</div>;
}

const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" }) + " NPT" : "never");

function ChannelRow({ name, c, extra }: { name: string; c: ChannelOps; extra?: React.ReactNode }) {
  const pct = c.acceptedLast7d ? Math.round((c.deliveredLast7d / c.acceptedLast7d) * 100) : null;
  return (
    <tr>
      <td><strong>{name}</strong></td>
      <td className="num">{c.scheduled.toLocaleString("en-IN")}</td>
      <td className="num">{c.awaitingCredits}</td>
      <td className="num">{c.accepted.toLocaleString("en-IN")}</td>
      <td className="num">{c.delivered.toLocaleString("en-IN")}{extra}</td>
      <td className={`num ${c.failed ? "text-bad" : ""}`}>{c.failed}</td>
      <td className={`num ${c.unknown ? "text-bad" : ""}`}>{c.unknown}</td>
      <td className="num">{pct === null ? "—" : `${pct}%`}</td>
      <td className="num">{c.creditsSpent30d.toLocaleString("en-IN")}{c.creditsRefunded30d ? <span className="small muted"> (−{c.creditsRefunded30d})</span> : null}</td>
    </tr>
  );
}

export default async function AdminOverview() {
  const [o, m, ops, clients, me] = await Promise.all([getOverview(), getMetrics(), getOps(), listClientsForAdmin(), getCurrentUser()]);
  const stale = ops.dispatcher.minutesSinceDispatch === null || ops.dispatcher.minutesSinceDispatch >= 3;
  const npr = (paisa: number) => `NPR ${(paisa / 100).toLocaleString("en-IN")}`;
  const wa = ops.whatsapp;
  const waProblems = [
    wa.enabled && wa.providerMode !== "meta" && wa.providerMode !== "mock" ? "WHATSAPP_PROVIDER is off on the server" : null,
    wa.enabled && wa.providerMode === "meta" && !wa.tokenConfigured ? "WHATSAPP_ACCESS_TOKEN missing" : null,
    wa.enabled && !wa.appSecretConfigured ? "WHATSAPP_APP_SECRET missing — webhooks will be rejected" : null,
    wa.enabled && !wa.phoneNumberIdSet ? "Phone number ID not set in WhatsApp settings" : null,
  ].filter(Boolean);
  const smsReportGap = ops.smsProvider.mode === "aakash" && ops.sms.acceptedLast7d > 0 && ops.sms.deliveredLast7d === 0;

  return (
    <div className="stack">
      {stale && <div className="alert bad" role="alert"><Icon name="alert" /> <span><strong>Dispatcher not running.</strong> Last run: {when(ops.dispatcher.lastDispatchAt)}. Scheduled messages will not go out. Check the <code>cron</code> container.</span></div>}
      {o.topups.pendingManual > 0 && <div className="alert info"><Icon name="qr" /> <span>{o.topups.pendingManual} QR top-up{o.topups.pendingManual > 1 ? "s" : ""} waiting for verification. <Link href="/admin/wallet/topups">Review →</Link></span></div>}
      {ops.sms.unknown + wa.unknown > 0 && <div className="alert warn"><Icon name="alert" /> <span>{ops.sms.unknown + wa.unknown} message(s) have an unknown outcome and are being reconciled. They are never re-sent blindly.</span></div>}
      {smsReportGap && <div className="alert warn"><Icon name="alert" /> <span><strong>No SMS delivery reports in 7 days.</strong> Aakash accepted {ops.sms.acceptedLast7d} SMS but no delivery status came back. Confirm the delivery-report API with Aakash (see docs/OPERATIONS.md); until then "accepted" is the strongest status we can show.</span></div>}
      {waProblems.length > 0 && <div className="alert warn"><Icon name="alert" /> <span><strong>WhatsApp configuration:</strong> {waProblems.join(" · ")}</span></div>}

      <h2>Message pipeline</h2>
      <div className="grid grid-4">
        <Stat label="Scheduled queue" value={ops.sms.scheduled + wa.scheduled} icon="clock" sub={`SMS ${ops.sms.scheduled} · WhatsApp ${wa.scheduled}`} href="/admin/messages?status=scheduled" />
        <Stat label="Failed" value={ops.sms.failed + wa.failed} icon="x" tone="bad" sub={`SMS ${ops.sms.failed} · WhatsApp ${wa.failed}`} href="/admin/messages?status=failed" />
        <Stat label="Unknown" value={ops.sms.unknown + wa.unknown} icon="alert" tone="bad" sub={`SMS ${ops.sms.unknown} · WhatsApp ${wa.unknown}`} href="/admin/messages?status=unknown" />
        <Stat label="Pending top-ups" value={o.topups.pendingManual} icon="qr" tone="yellow" sub={`${o.topups.awaitingPayment} awaiting payment`} href="/admin/wallet/topups" />
      </div>

      <section className="card">
        <h2>Channels</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Channel</th><th className="num">Scheduled</th><th className="num">Awaiting credits</th><th className="num">Accepted</th><th className="num">Delivered</th><th className="num">Failed</th><th className="num">Unknown</th><th className="num">Delivery rate 7d</th><th className="num">Credits spent 30d</th></tr></thead>
            <tbody>
              <ChannelRow name="SMS" c={ops.sms} />
              <ChannelRow name="WhatsApp" c={wa} extra={<span className="small muted"> · read {wa.read}</span>} />
            </tbody>
          </table>
        </div>
        <p className="hint mt mb-0">Accepted = provider took the message (charged). Delivered/read come from provider reports. Failed after acceptance is refunded automatically.</p>
      </section>

      <h2>Money</h2>
      <div className="grid grid-4">
        <Stat label="Revenue" value={npr(o.revenue.gatewayPaisa + o.revenue.manualPaisa)} icon="receipt" sub={`Khalti ${npr(o.revenue.gatewayPaisa)} · QR ${npr(o.revenue.manualPaisa)}`} />
        <Stat label="Credits purchased" value={o.credits.purchased} icon="wallet" sub="lifetime" />
        <Stat label="Outstanding liability" value={o.credits.outstanding} icon="lock" tone="yellow" sub={`${o.credits.reserved} reserved for scheduled messages`} />
        <Stat label="Credits spent" value={o.credits.spent} icon="chart" sub={`30d: SMS ${ops.sms.creditsSpent30d} · WhatsApp ${wa.creditsSpent30d}`} />
      </div>

      <div className="grid grid-2">
        <section className="card">
          <h2>Health</h2>
          <dl className="kv">
            <dt>Dispatcher</dt><dd>{when(ops.dispatcher.lastDispatchAt)}{ops.dispatcher.minutesSinceDispatch !== null ? ` (${ops.dispatcher.minutesSinceDispatch} min ago)` : ""}</dd>
            <dt>Reconciler</dt><dd>{when(ops.dispatcher.lastReconcileAt)}</dd>
            <dt>SMS provider</dt><dd>{ops.smsProvider.mode}{ops.smsProvider.mode === "mock" ? " (development — no real SMS)" : ""} · token {ops.smsProvider.tokenConfigured ? "configured" : "not set"}</dd>
            <dt>Last SMS attempt</dt><dd>{when(ops.sms.lastAttemptAt)} · {ops.sms.lastAttemptState ?? "—"}{ops.sms.lastError ? ` · ${ops.sms.lastError.slice(0, 80)}` : ""}</dd>
            <dt>SMS delivery reports (7d)</dt><dd>{ops.smsProvider.reportsLast7d} received · {ops.smsProvider.reportsUnknownLast7d} accepted &gt;1 day ago with no report</dd>
            <dt>WhatsApp</dt><dd>{wa.enabled ? "enabled" : "disabled"} · provider {wa.providerMode} · token {wa.tokenConfigured ? "configured" : "not set"}</dd>
            <dt>WhatsApp webhook</dt><dd>verified {when(wa.webhookVerifiedAt)} · last event {when(wa.lastWebhookAt)}{wa.lastWebhookSignatureOk === false ? " (signature FAILED)" : ""}</dd>
            <dt>Last WhatsApp send</dt><dd>{when(wa.lastAttemptAt)} · {wa.lastAttemptState ?? "—"}{wa.lastError ? ` · ${wa.lastError.slice(0, 80)}` : ""}</dd>
            <dt>Payment gateway</dt><dd>{env.paymentGateway}</dd>
          </dl>
          <p className="hint mt mb-0">Secrets live only in the server environment and are never shown here.</p>
        </section>
        <section className="card">
          <div className="card-head"><h2>Low balance (active reminders)</h2></div>
          {ops.lowBalance.length === 0 ? <p className="muted mb-0">No customers with active reminders below 10 credits.</p> : (
            <div className="list">
              {ops.lowBalance.map((u) => (
                <Link key={u.id} href={`/admin/users/${u.id}`} className="list-item" style={{ color: "inherit", textDecoration: "none" }}>
                  <span className="grow"><span className="title" style={{ display: "block" }}>{u.name ?? formatPhoneLocal(u.phone)}</span><span className="meta">{u.pending ? `${u.pending} message(s) awaiting credits` : "reminders funded"}</span></span>
                  <strong className={u.available < 0 ? "text-bad" : ""}>{u.available}</strong>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <h2>Users</h2>
          <dl className="kv">
            <dt>Registered</dt><dd>{o.users.total} ({m.users.last7d} new in 7 days)</dd>
            <dt>Verified</dt><dd>{o.users.verified}</dd>
            <dt>Active reminders</dt><dd>{o.reminders.active} ({o.reminders.paused} paused)</dd>
            <dt>Staff accounts</dt><dd>{o.users.admins}</dd>
          </dl>
        </section>
        <section className="card">
          <h2>AI assistants (MCP)</h2>
          <dl className="kv">
            <dt>Connected users</dt><dd>{m.mcp.connectedUsers}</dd>
            <dt>Tool calls (24h)</dt><dd>{m.mcp.toolCalls24h} ({m.mcp.toolErrors24h} errors)</dd>
            <dt>Unauthorized (24h)</dt><dd>{m.mcp.unauthorized24h}</dd>
            <dt>Prepared / confirmed</dt><dd>{m.mcp.prepared24h} / {m.mcp.confirmed24h}</dd>
          </dl>
        </section>
      </div>

      {can(me?.role, "oauth.manage") && (
        <section className="card">
          <h2>OAuth / MCP clients</h2>
          <AdminClients clients={clients} />
        </section>
      )}
    </div>
  );
}
