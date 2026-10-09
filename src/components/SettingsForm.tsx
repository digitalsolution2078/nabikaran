"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";

export function SettingsForm({ displayName, locale }: { displayName: string; locale: string }) {
  const router = useRouter();
  const [name, setName] = useState(displayName);
  const [loc, setLoc] = useState(locale);
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    await api("/api/me", { method: "PATCH", json: { displayName: name, locale: loc } });
    setMsg("Saved"); router.refresh();
  }
  async function exportData() {
    const data = await api("/api/me", { method: "POST", json: { action: "export" } });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "nabikaran-export.json"; a.click();
  }
  async function closeAccount() {
    if (!confirm("Close your account? Scheduled reminders are cancelled. Remaining prepaid credits are handled under the closure/refund policy.")) return;
    await api("/api/me", { method: "POST", json: { action: "delete" } });
    router.push("/"); router.refresh();
  }
  return (
    <form onSubmit={save} className="card">
      <label>Display name</label>
      <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      <label>SMS language</label>
      <select value={loc} onChange={(e) => setLoc(e.target.value)}>
        <option value="ne-NP">नेपाली (default)</option>
        <option value="en-NP">English</option>
      </select>
      <div className="row" style={{ marginTop: 12 }}>
        <button type="submit">Save</button>
        <button type="button" className="secondary" onClick={exportData}>Export my data</button>
        <button type="button" className="danger" onClick={closeAccount}>Close account</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </form>
  );
}
