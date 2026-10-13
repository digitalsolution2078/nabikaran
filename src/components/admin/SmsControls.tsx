"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import { validateTemplateBody } from "@/lib/sms/templates";

export function SmsTemplateEditor({ locale, category, body }: { locale: "en-NP" | "ne-NP"; category: "default" | "today"; body: string }) {
  const router = useRouter();
  const [value, setValue] = useState(body);
  const [msg, setMsg] = useState<string | null>(null);
  const check = useMemo(() => validateTemplateBody(value, category), [value, category]);
  async function save() {
    try {
      await api("/api/admin/sms-templates", { method: "POST", json: { locale, category, body: value } });
      setMsg("Saved as a new version.");
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <div className="mt">
      <textarea rows={3} value={value} onChange={(e) => { setValue(e.target.value); setMsg(null); }} aria-label={`${locale} ${category} template`} className="mono" />
      <div className="row between mt">
        <span className={`small ${check.ok ? "muted" : ""}`} style={{ color: check.ok ? undefined : "var(--bad)" }}>{check.ok ? `OK · worst case ${check.worstCaseSeptets}/160` : check.error}</span>
        <button className="btn btn-secondary btn-sm" disabled={!check.ok || value === body} onClick={save}>Save</button>
      </div>
      {msg && <p className="small mt mb-0" role="status">{msg}</p>}
    </div>
  );
}

export function PricingEditor({ current, channel = "sms" }: { current: number; channel?: "sms" | "whatsapp" | "email" }) {
  const unit = channel === "sms" ? "SMS unit (160 characters)" : channel === "email" ? "email" : "accepted WhatsApp message";
  const router = useRouter();
  const [value, setValue] = useState(String(current));
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0.01 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6) {
      setMsg("Use a price like 1.50 or 0.30 (two decimals at most).");
      return;
    }
    if (!confirm(`Set the customer price to ${n.toFixed(2)} credits (NPR ${n.toFixed(2)}) per ${unit} from now?\n\nExisting scheduled reminders keep their reserved price; only new schedules use the new price.`)) return;
    try {
      await api("/api/admin/pricing", { method: "POST", json: { channel, creditsPerUnit: n, confirm: true } });
      setMsg("New price active for new schedules.");
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <div className="row mt">
      <label htmlFor={`price-${channel}`} className="sr-only">Credits per {unit}</label>
      <input id={`price-${channel}`} type="number" min={0.01} step={0.01} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 120 }} />
      <button className="btn btn-secondary" disabled={Number(value) === current} onClick={save}>Update price</button>
      {msg && <span className="small" role="status">{msg}</span>}
    </div>
  );
}
