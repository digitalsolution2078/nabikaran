import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getMetrics } from "@/lib/services/admin";
import { listClientsForAdmin } from "@/lib/oauth/tokens";
import { AdminClients } from "@/components/AdminClients";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");
  const [m, clients] = await Promise.all([getMetrics(), listClientsForAdmin()]);
  const stale = m.worker.minutesSinceDispatch === null || m.worker.minutesSinceDispatch >= 3;
  return (
    <div>
      <h1>Admin</h1>
      {stale && <p className="notice">Scheduler health: no dispatcher run in the last 3 minutes{m.worker.lastDispatchAt ? ` (last ${m.worker.lastDispatchAt})` : ""}.</p>}
      <h2>Users</h2>
      <div className="grid">
        <div className="stat"><div className="n">{m.users.total}</div><div className="l">Total</div></div>
        <div className="stat"><div className="n">{m.users.verified}</div><div className="l">Verified</div></div>
        <div className="stat"><div className="n">{m.users.last7d}</div><div className="l">New (7d)</div></div>
      </div>
      <h2>Wallet liability</h2>
      <div className="grid">
        <div className="stat"><div className="n">{m.wallet.postedLiabilityCredits}</div><div className="l">Prepaid credits outstanding (NPR)</div></div>
        <div className="stat"><div className="n">{m.wallet.reservedCredits}</div><div className="l">Reserved</div></div>
        <div className="stat"><div className="n">{m.wallet.topupsPaid}</div><div className="l">Paid top-ups</div></div>
        <div className="stat"><div className="n">NPR {m.wallet.topupRevenuePaisa / 100}</div><div className="l">Gross top-up value</div></div>
      </div>
      <h2>Jobs</h2>
      <div className="grid">{Object.entries(m.jobs).map(([k, v]) => <div className="stat" key={k}><div className="n">{v}</div><div className="l">{k}</div></div>)}</div>
      <h2>SMS &amp; payments</h2>
      <div className="grid">
        <div className="stat"><div className="n">{m.sms.accepted24h}/{m.sms.attempts24h}</div><div className="l">Accepted / attempts (24h)</div></div>
        <div className="stat"><div className="n">{m.sms.unknownOpen}</div><div className="l">Unknown attempts needing action</div></div>
        <div className="stat"><div className="n">{m.payments.pendingOrders}</div><div className="l">Pending orders</div></div>
        <div className="stat"><div className="n">{m.payments.mismatches}</div><div className="l">Amount mismatches</div></div>
      </div>
      <h2>AI assistants (MCP)</h2>
      <div className="grid">
        <div className="stat"><div className="n">{m.mcp.connectedUsers}</div><div className="l">Users with a connected app</div></div>
        <div className="stat"><div className="n">{m.mcp.toolCalls24h}</div><div className="l">Tool calls (24h)</div></div>
        <div className="stat"><div className="n">{m.mcp.toolErrors24h}</div><div className="l">Tool errors (24h)</div></div>
        <div className="stat"><div className="n">{m.mcp.unauthorized24h}</div><div className="l">401s (24h)</div></div>
        <div className="stat"><div className="n">{m.mcp.prepared24h} / {m.mcp.confirmed24h}</div><div className="l">Prepared / confirmed (24h)</div></div>
      </div>
      {m.mcp.toolCalls24h > 0 && m.mcp.toolErrors24h / m.mcp.toolCalls24h > 0.2 && <p className="notice">MCP tool error rate above 20% in the last 24h.</p>}
      <AdminClients clients={clients} />
      <p className="muted" style={{ fontSize: 13 }}>Pricing changes: <code>POST /api/admin/pricing</code> (preview then confirm). Wallet adjustments: <code>POST /api/admin/adjustments</code> — request by one admin, approve by another.</p>
    </div>
  );
}
