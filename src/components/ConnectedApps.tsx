"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { formatDate, formatDateTime } from "@/lib/i18n/format";

export interface Connection {
  clientId: string;
  name: string;
  scopes: string[];
  connectedAt: string;
  lastUsedAt: string | null;
}

export function ConnectedApps({ connections }: { connections: Connection[] }) {
  const router = useRouter();
  const { t, prefs } = usePrefs();
  const [busy, setBusy] = useState<string | null>(null);
  async function disconnect(clientId: string) {
    if (!confirm(t("apps.confirm"))) return;
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
      <h2 style={{ marginTop: 0 }}>{t("apps.title")}</h2>
      {connections.length === 0 ? (
        <p className="muted">{t("apps.none")}</p>
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>{t("apps.app")}</th><th>{t("apps.access")}</th><th>{t("apps.lastUsed")}</th><th /></tr></thead>
          <tbody>
            {connections.map((c) => (
              <tr key={c.clientId}>
                <td>{c.name}<br /><span className="muted" style={{ fontSize: 12 }}>{t("apps.since", { date: formatDate(c.connectedAt, prefs) })}</span></td>
                <td className="muted" style={{ fontSize: 13 }}>{c.scopes.join(", ")}</td>
                <td className="muted" style={{ fontSize: 13 }}>{c.lastUsedAt ? formatDateTime(c.lastUsedAt, prefs) : t("apps.never")}</td>
                <td><button className="btn btn-secondary btn-sm" disabled={busy === c.clientId} onClick={() => disconnect(c.clientId)}>{t("apps.disconnect")}</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
