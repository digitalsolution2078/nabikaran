"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";

/** Admin → customer: switch business tools (clients) on or off, optionally setting the business name. */
export function BusinessAccess({ userId, allowed, name, clients, reminders }: { userId: string; allowed: boolean; name: string | null; clients: number; reminders: number }) {
  const router = useRouter();
  const [biz, setBiz] = useState(name ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  async function save(next: boolean) {
    if (!next && reminders > 0 && !window.confirm(`This account has ${reminders} active client reminder(s). They will be cancelled with credits returned when they fall due. Turn business tools off?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/admin/users/${userId}/business`, { method: "PUT", json: { allowed: next, name: biz.trim() || null } });
      setMsg({ tone: "ok", text: next ? "Business tools are on for this account." : "Business tools are off for this account." });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <p className="small muted">{allowed ? `On${name ? ` · ${name}` : " · the customer has not set a business name yet"} · ${clients} client(s) · ${reminders} active client reminder(s).` : "Off. The customer sees a \"Request business tools\" button in Settings."}</p>
      <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="field mb-0 grow" style={{ minWidth: 200 }}>
          <label htmlFor="ba-name">Business name (shown in client SMS, optional)</label>
          <input id="ba-name" value={biz} maxLength={20} onChange={(e) => setBiz(e.target.value)} placeholder="e.g. Ram Motors" />
        </div>
        {allowed
          ? <><button type="button" className="btn btn-secondary btn-sm" disabled={busy || !biz.trim() || biz.trim() === name} onClick={() => save(true)}>Save name</button><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => save(false)}>Turn off</button></>
          : <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => save(true)}>Give business tools</button>}
      </div>
      {msg && <div className={`alert ${msg.tone} mt`} role="status">{msg.text}</div>}
    </div>
  );
}
