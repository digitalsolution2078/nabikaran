"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";

export interface ClientRow {
  id: string;
  name: string;
  createdAt: string;
  disabledAt: string | null;
  activeUsers: number;
  activeTokens: number;
}

export function AdminClients({ clients }: { clients: ClientRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  async function toggle(c: ClientRow) {
    const action = c.disabledAt ? "enable" : "disable";
    if (action === "disable" && !confirm(`Disable "${c.name}"? Every user's connection through this app stops working immediately.`)) return;
    setBusy(c.id);
    try {
      await api("/api/admin/oauth-clients", { method: "POST", json: { clientId: c.id, action } });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }
  return (
    <table>
      <thead><tr><th>Client</th><th>Users</th><th>Live tokens</th><th>State</th><th /></tr></thead>
      <tbody>
        {clients.map((c) => (
          <tr key={c.id}>
            <td>{c.name}<br /><span className="muted" style={{ fontSize: 12 }}>{c.id} · {new Date(c.createdAt).toLocaleDateString("en-GB")}</span></td>
            <td>{c.activeUsers}</td>
            <td>{c.activeTokens}</td>
            <td><span className={`badge ${c.disabledAt ? "bad" : "ok"}`}>{c.disabledAt ? "disabled" : "enabled"}</span></td>
            <td><button className={c.disabledAt ? "secondary" : "danger"} disabled={busy === c.id} onClick={() => toggle(c)}>{c.disabledAt ? "Enable" : "Disable"}</button></td>
          </tr>
        ))}
        {clients.length === 0 && <tr><td colSpan={5} className="muted">No OAuth clients registered yet.</td></tr>}
      </tbody>
    </table>
  );
}
