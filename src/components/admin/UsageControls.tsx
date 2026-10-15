"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import { Icon } from "../Icon";

/** "Check now" for the SMS provider balance. */
export function CheckBalance() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={async () => {
        setBusy(true);
        setErr(null);
        try {
          await api("/api/admin/usage", { method: "POST", json: { action: "check_balance" } });
          router.refresh();
        } catch (e) {
          setErr((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}>{busy ? <span className="spinner" /> : <Icon name="repeat" size={16} />} Check now</button>
      {err && <span className="small" style={{ color: "var(--bad)" }}>{err}</span>}
    </span>
  );
}

type S = { alert: boolean; lowBalance: number; smsCost: number; whatsappCost: number; emailCost: number };

/** Super admin: low-balance alert level and what each message costs us. */
export function UsageSettingsForm({ initial }: { initial: S }) {
  const router = useRouter();
  const [f, setF] = useState({ alert: initial.alert, low: String(initial.lowBalance), sms: String(initial.smsCost), wa: String(initial.whatsappCost), email: String(initial.emailCost) });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/admin/settings", { method: "POST", json: { key: "usage", value: { alert: f.alert, low_balance: Math.floor(Number(f.low) || 0), sms_cost: Number(f.sms) || 0, whatsapp_cost: Number(f.wa) || 0, email_cost: Number(f.email) || 0 } } });
      setMsg({ tone: "ok", text: "Saved." });
      router.refresh();
    } catch (e2) {
      setMsg({ tone: "bad", text: (e2 as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const num = (id: string, label: string, v: string, set: (v: string) => void, hint: string, step = "0.01") => (
    <div className="field"><label htmlFor={id}>{label}</label><input id={id} type="number" min={0} step={step} value={v} onChange={(e) => set(e.target.value)} /><span className="hint">{hint}</span></div>
  );
  return (
    <form onSubmit={save}>
      <label className="row small"><input type="checkbox" checked={f.alert} onChange={(e) => setF({ ...f, alert: e.target.checked })} /> Alert super admins (app + email, once a day) when the SMS balance is low</label>
      <div className="grid grid-2 mt">
        {num("us-low", "Alert below (SMS credits)", f.low, (v) => setF({ ...f, low: v }), "Aakash credits left.", "1")}
        {num("us-sms", "Our cost per SMS (NPR)", f.sms, (v) => setF({ ...f, sms: v }), "What Aakash charges per SMS part.")}
        {num("us-wa", "Our cost per WhatsApp (NPR)", f.wa, (v) => setF({ ...f, wa: v }), "Meta utility template rate.")}
        {num("us-email", "Our cost per email (NPR)", f.email, (v) => setF({ ...f, email: v }), "Resend plan ÷ emails (often 0).")}
      </div>
      {msg && <div className={`alert ${msg.tone}`} role="status">{msg.text}</div>}
      <button className="btn btn-primary btn-sm" disabled={busy}>Save</button>
    </form>
  );
}
