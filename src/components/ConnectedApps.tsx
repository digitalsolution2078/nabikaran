"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";

export interface Connection {
  clientId: string;
  name: string;
  scopes: string[];
  connectedAt: string;
  lastUsedAt: string | null;
}

export function ConnectedApps({ connections }: { connections: Connection[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  async function disconnect(clientId: string) {
    if (!confirm("Disconnect this app? It will lose access immediately.")) return;
    setBusy(clientId);
    try {
      await api("/api/me/connections", { method: "DELETE", json: { clientId } });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Connected apps</h2>
      {connections.length === 0 ? (
        <p className="muted">No AI assistants or apps are connected. Connect ChatGPT or Claude from the assistant's connector settings using the Nabikaran MCP server.</p>
      ) : (
        <table>
          <thead><tr><th>App</th><th>Access</th><th>Last used</th><th /></tr></thead>
          <tbody>
            {connections.map((c) => (
              <tr key={c.clientId}>
                <td>{c.name}<br /><span className="muted" style={{ fontSize: 12 }}>since {new Date(c.connectedAt).toLocaleDateString("en-GB", { timeZone: "Asia/Kathmandu" })}</span></td>
                <td className="muted" style={{ fontSize: 13 }}>{c.scopes.join(", ")}</td>
                <td className="muted" style={{ fontSize: 13 }}>{c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu" }) : "never"}</td>
                <td><button className="danger" disabled={busy === c.clientId} onClick={() => disconnect(c.clientId)}>Disconnect</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
