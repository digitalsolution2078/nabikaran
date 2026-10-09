import Link from "next/link";
import { getMetrics } from "@/lib/services/admin";
import { getOverview } from "@/lib/services/admin-console";
import { listClientsForAdmin } from "@/lib/oauth/tokens";
import { AdminClients } from "@/components/AdminClients";
import { Icon } from "@/components/Icon";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

function Stat({ label, value, sub, icon, tone }: { label: string; value: string | number; sub?: string; icon: Parameters<typeof Icon>[0]["name"]; tone?: "orange" | "yellow" }) {
  return (
    <div className="stat">
      <div className="label"><span className={`icon-chip ${tone ?? ""}`}><Icon name={icon} size={16} /></span>{label}</div>
      <div className="value">{typeof value === "number" ? value.toLocaleString("en-IN") : value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export default async function AdminOverview() {
  const [o, m, clients] = await Promise.all([getOverview(), getMetrics(), listClientsForAdmin()]);
  const stale = m.worker.minutesSinceDispatch === null || m.worker.minutesSinceDispatch >= 3;
  const npr = (paisa: number) => `NPR ${(paisa / 100).toLocaleString("en-IN")}`;
  return (
    <div className="stack">
      {stale && <div className="alert warn"><Icon name="alert" /> Scheduler health: no dispatcher run in the last 3 minutes{m.worker.lastDispatchAt ? ` (last ${m.worker.lastDispatchAt})` : ""}. Check the cron container.</div>}
      {o.topups.pendingManual > 0 && (
        <div className="alert info"><Icon name="qr" /> <span>{o.topups.pendingManual} QR top-up{o.topups.pendingManual > 1 ? "s" : ""} waiting for verification. <Link href="/admin/wallet/topups">Review →</Link></span></div>
      )}

      <h2>Users & reminders</h2>
      <div className="grid grid-4">
        <Stat label="Registered users" value={o.users.total} icon="users" sub={`${m.users.last7d} new in 7 days`} />
        <Stat label="Verified users" value={o.users.verified} icon="check" />
        <Stat label="Active reminders" value={o.reminders.active} icon="bell" sub={`${o.reminders.paused} paused`} />
        <Stat label="Admins" value={o.users.admins} icon="shield" />
      </div>

      <h2>SMS</h2>
      <div className="grid grid-4">
        <Stat label="Sent (accepted)" value={o.sms.submitted + o.sms.delivered} icon="message" sub={`${o.sms.delivered} delivery-confirmed`} />
        <Stat label="Failed" value={o.sms.failed} icon="x" tone="orange" />
        <Stat label="Pending / scheduled" value={o.sms.pending} icon="clock" tone="yellow" />
        <Stat label="Unknown (reconcile)" value={o.sms.unknown} icon="alert" tone="orange" sub={`${m.sms.accepted24h}/${m.sms.attempts24h} accepted in 24h`} />
      </div>

      <h2>Credits & revenue</h2>
      <div className="grid grid-4">
        <Stat label="Credits purchased" value={o.credits.purchased} icon="wallet" sub="all top-ups, lifetime" />
        <Stat label="Outstanding liability" value={o.credits.outstanding} icon="lock" tone="yellow" sub={`${o.credits.reserved} reserved for scheduled SMS`} />
        <Stat label="Credits spent on SMS" value={o.credits.spent} icon="chart" />
        <Stat label="Revenue" value={npr(o.revenue.gatewayPaisa + o.revenue.manualPaisa)} icon="receipt" tone="orange" sub={`Gateway ${npr(o.revenue.gatewayPaisa)} · QR ${npr(o.revenue.manualPaisa)}`} />
      </div>

      <div className="grid grid-2">
        <section className="card">
          <h2>SMS provider</h2>
          <dl className="kv">
            <dt>Provider</dt><dd>{env.smsProvider}{env.smsProvider === "mock" ? " (development — no real SMS)" : ""}</dd>
            <dt>API token</dt><dd>{env.aakash.authToken ? "configured (hidden)" : "not set"}</dd>
            <dt>Last dispatcher run</dt><dd>{m.worker.lastDispatchAt ?? "never"}</dd>
            <dt>Payment gateway</dt><dd>{env.paymentGateway}</dd>
          </dl>
          <p className="hint mt mb-0">Credentials are set only in the server environment (<code>.env.production</code>), never in the database or this page.</p>
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

      <section className="card">
        <h2>OAuth / MCP clients</h2>
        <AdminClients clients={clients} />
      </section>
    </div>
  );
}
