"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import type { CompanySettings } from "@/lib/services/settings";

/** Admin: company details shown in the footer and on receipts. */
export function CompanyAdmin({ settings }: { settings: CompanySettings }) {
  const router = useRouter();
  const [s, setS] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/admin/settings", { method: "POST", json: { key: "company", value: s } });
      setMsg({ tone: "ok", text: "Saved. The footer and receipts show the new details." });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const f = (id: keyof CompanySettings, label: string, hint?: string) => (
    <div className="field"><label htmlFor={`co-${id}`}>{label}</label><input id={`co-${id}`} value={s[id]} maxLength={120} onChange={(e) => setS({ ...s, [id]: e.target.value })} />{hint && <span className="hint">{hint}</span>}</div>
  );
  return (
    <section className="card">
      <h2>Company details</h2>
      <p className="small muted">Shown in the footer of every page and on payment receipts. Payment partners and customers check this.</p>
      <div className="grid grid-2">
        {f("name", "Registered company name")}
        {f("pan", "PAN / VAT number", "Leave empty until registered.")}
        {f("address", "Address")}
        {f("phone", "Support phone", "e.g. 061-XXXXXX or 98XXXXXXXX")}
        {f("email", "Support email")}
      </div>
      {msg && <div className={`alert ${msg.tone}`} role="status">{msg.text}</div>}
      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>Save</button>
    </section>
  );
}
