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

export function PricingEditor({ current }: { current: number }) {
  const router = useRouter();
  const [value, setValue] = useState(String(current));
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return;
    if (!confirm(`Set the customer price to ${n} credits per SMS from now?\n\nExisting scheduled reminders keep their reserved price; only new schedules use the new price.`)) return;
    try {
      await api("/api/admin/pricing", { method: "POST", json: { creditsPerUnit: n, confirm: true } });
      setMsg("New price active for new schedules.");
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <div className="row mt">
      <label htmlFor="price" className="sr-only">Credits per SMS</label>
      <input id="price" type="number" min={1} step={1} value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 120 }} />
      <button className="btn btn-secondary" disabled={Number(value) === current} onClick={save}>Update price</button>
      {msg && <span className="small" role="status">{msg}</span>}
    </div>
  );
}
