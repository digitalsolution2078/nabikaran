import { requireAdminPage } from "@/lib/auth/admin-page";
import { listClientsForAdmin, listMcpConnectionsForAdmin } from "@/lib/oauth/tokens";
import { getMetrics } from "@/lib/services/admin";
import { McpConnections } from "@/components/admin/McpConnections";
import { AdminClients } from "@/components/AdminClients";
import { can } from "@/lib/auth/rbac";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI apps (MCP)" };

export default async function AdminMcp() {
  const me = await requireAdminPage();
  const manage = can(me.role, "oauth.manage");
  const [rows, m, clients] = await Promise.all([listMcpConnectionsForAdmin({ limit: 500 }), getMetrics(), manage ? listClientsForAdmin() : Promise.resolve([])]);
  return (
    <div className="stack">
      <div className="stat-grid">
        <div className="stat"><div className="label">Connected customers</div><div className="value">{m.mcp.connectedUsers}</div></div>
        <div className="stat"><div className="label">Tool calls (24h)</div><div className="value">{m.mcp.toolCalls24h}</div><div className="sub">{m.mcp.toolErrors24h} errors</div></div>
        <div className="stat"><div className="label">Prepared / confirmed (24h)</div><div className="value">{m.mcp.prepared24h} / {m.mcp.confirmed24h}</div></div>
      </div>
      <section className="card">
        <div className="card-head"><h2>Connected customers</h2><span className="small muted">{rows.length} connection{rows.length === 1 ? "" : "s"}</span></div>
        <McpConnections rows={rows} canManage={manage} />
      </section>
      {manage && (
        <section className="card">
          <h2>Apps (OAuth clients)</h2>
          <AdminClients clients={clients} />
        </section>
      )}
    </div>
  );
}
