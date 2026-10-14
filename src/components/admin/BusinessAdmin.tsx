"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import type { BusinessSettings } from "@/lib/services/settings";

/** Admin: business accounts switch, client limit, and numbers blocked from client reminders. */
export function BusinessAdmin({ settings, blocked, stats, canBlock }: { settings: BusinessSettings; blocked: Array<{ phone: string; reason: string | null; createdAt: string }>; stats: { accounts: number; clients: number; reminders: number }; canBlock: boolean }) {
  const router = useRouter();
  const [s, setS] = useState({ enabled: settings.enabled, max: String(settings.max_clients) });
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "ok", text: ok });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Business accounts (clients)</h2>
      <p className="small muted">Dealers, insurance agents and consultancies keep reminders for their clients. Client reminders go by SMS to the client&apos;s phone, signed with the business name; the business pays from its wallet. Businesses confirm each client agreed to receive the SMS.</p>
      <div className="grid grid-3">
        <div className="stat"><div className="label">Business accounts</div><div className="value">{stats.accounts}</div></div>
        <div className="stat"><div className="label">Clients</div><div className="value">{stats.clients}</div></div>
        <div className="stat"><div className="label">Active client reminders</div><div className="value">{stats.reminders}</div></div>
      </div>
      {msg && <div className={`alert ${msg.tone} mt`} role="status">{msg.text}</div>}
      <div className="grid grid-2 mt">
        <div className="field"><span className="label">Availability</span><label className="row small"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Customers can turn on business tools</label></div>
        <div className="field"><label htmlFor="biz-max">Most clients per account</label><input id="biz-max" type="number" min={1} max={100000} value={s.max} onChange={(e) => setS({ ...s, max: e.target.value })} /></div>
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api("/api/admin/settings", { method: "POST", json: { key: "business", value: { enabled: s.enabled, max_clients: Number(s.max) } } }), "Saved and recorded in the audit log.")}>Save business settings</button>

      <h3 className="mt">Blocked numbers</h3>
      <p className="small muted">If someone complains about client reminders, block their number: their pending client reminders are cancelled (credits returned to the business) and no business can add it again.</p>
      {canBlock && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input type="tel" aria-label="Mobile number" placeholder="98XXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ maxWidth: 180 }} />
          <input type="text" aria-label="Reason" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: "1 1 200px" }} />
          <button className="btn btn-secondary" disabled={busy || !phone.trim()} onClick={() => run(async () => { await api("/api/admin/blocked-recipients", { method: "POST", json: { phone, reason: reason || null } }); setPhone(""); setReason(""); }, "Number blocked.")}>Block number</button>
        </div>
      )}
      {blocked.length === 0 ? <p className="muted mt mb-0">No blocked numbers.</p> : (
        <div className="list mt">
          {blocked.map((b) => (
            <div className="list-item" key={b.phone}>
              <span className="grow"><strong>{b.phone}</strong><br /><span className="small muted">{b.reason ?? "—"} · {b.createdAt.slice(0, 10)}</span></span>
              {canBlock && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api("/api/admin/blocked-recipients", { method: "POST", json: { phone: b.phone, action: "unblock" } }), "Number unblocked.")}>Unblock</button>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
