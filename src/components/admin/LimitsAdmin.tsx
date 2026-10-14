"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import type { LimitsSettings } from "@/lib/services/settings";

/** Admin: how many records Free and Pro accounts can keep. */
export function LimitsAdmin({ settings, stats }: { settings: LimitsSettings; stats: { overFree: number; nearFree: number } }) {
  const router = useRouter();
  const [s, setS] = useState({ free: String(settings.free_records), pro: String(settings.pro_records) });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/admin/settings", { method: "POST", json: { key: "limits", value: { free_records: Number(s.free), pro_records: Number(s.pro) } } });
      setMsg({ tone: "ok", text: "Saved and recorded in the audit log." });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>Record limits</h2>
      <p className="small muted">How many records (with or without reminders) an account can keep. Active and paused records count; deleted ones do not. Accounts over a lowered limit keep everything; they just cannot add more until they delete some or go Pro.</p>
      <div className="grid grid-2">
        <div className="field"><label htmlFor="lim-free">Free accounts</label><input id="lim-free" type="number" min={1} value={s.free} onChange={(e) => setS({ ...s, free: e.target.value })} /></div>
        <div className="field"><label htmlFor="lim-pro">Pro accounts</label><input id="lim-pro" type="number" min={1} value={s.pro} onChange={(e) => setS({ ...s, pro: e.target.value })} /></div>
      </div>
      <p className="hint">Free accounts at or over the limit: <strong>{stats.overFree}</strong> · within 20 of it: <strong>{stats.nearFree}</strong> (good people to offer Pro).</p>
      {msg && <div className={`alert ${msg.tone}`} role="status">{msg.text}</div>}
      <button className="btn btn-primary" disabled={busy} onClick={save}>Save limits</button>
    </section>
  );
}
