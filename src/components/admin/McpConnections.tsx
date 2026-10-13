"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";

export interface McpConnectionRow {
  userId: string;
  userName: string | null;
  phone: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  connectedAt: string;
  lastUsedAt: string | null;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" }) : "—");

/** Who is connected through which AI app. Staff with oauth.manage can disconnect one customer from one app. */
export function McpConnections({ rows, canManage, showUser = true }: { rows: McpConnectionRow[]; canManage: boolean; showUser?: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const list = q.trim()
    ? rows.filter((r) => `${r.userName ?? ""} ${r.phone} ${r.clientName}`.toLowerCase().includes(q.trim().toLowerCase()))
    : rows;
  async function disconnect(r: McpConnectionRow) {
    if (!confirm(`Disconnect ${r.userName ?? r.phone} from ${r.clientName}? The assistant loses access immediately; the customer can connect again.`)) return;
    const key = `${r.userId}:${r.clientId}`;
    setBusy(key);
    try {
      await api("/api/admin/oauth-clients", { method: "POST", json: { clientId: r.clientId, action: "disconnect_user", userId: r.userId } });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="stack" style={{ gap: 10 }}>
      {showUser && rows.length > 8 && (
        <input type="search" placeholder="Search name, phone or app" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search connections" />
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>{showUser && <th>Customer</th>}<th>App</th><th>Access</th><th>Connected</th><th>Last used</th>{canManage && <th />}</tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={`${r.userId}:${r.clientId}`}>
                {showUser && (
                  <td>
                    <Link href={`/admin/users/${r.userId}`}><strong>{r.userName ?? "—"}</strong></Link>
                    <br /><span className="small muted">{r.phone}</span>
                  </td>
                )}
                <td>{r.clientName}<br /><span className="small muted mono">{r.clientId}</span></td>
                <td className="small muted">{r.scopes.join(", ")}</td>
                <td className="small nowrap">{when(r.connectedAt)}</td>
                <td className="small nowrap">{when(r.lastUsedAt)}</td>
                {canManage && (
                  <td><button className="btn btn-secondary btn-sm" disabled={busy === `${r.userId}:${r.clientId}`} onClick={() => disconnect(r)}>Disconnect</button></td>
                )}
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={6} className="muted">{q ? "No match." : "No customer has connected an AI assistant yet."}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
