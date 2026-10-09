"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";

export function AdjustCredits({ userId, direct }: { userId: string; direct: boolean }) {
  const router = useRouter();
  const [direction, setDirection] = useState<"credit" | "debit">("credit");
  const [credits, setCredits] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const n = Number(credits);
  const valid = Number.isInteger(n) && n > 0 && reason.trim().length >= 5;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    const verb = direction === "credit" ? "ADD" : "REMOVE";
    if (!confirm(`${verb} ${n} credits ${direction === "credit" ? "to" : "from"} this wallet?\n\nReason: ${reason}\n\n${direct ? "This applies immediately and is recorded in the audit log." : "This creates a request that another admin must approve."}`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ applied: boolean }>(`/api/admin/users/${userId}`, { method: "POST", json: { action: "adjust", direction, credits: n, reason, idempotencyKey: crypto.randomUUID(), confirm: true } });
      setMsg({ tone: "ok", text: r.applied ? "Adjustment applied." : "Adjustment requested — waiting for a second admin's approval." });
      setCredits("");
      setReason("");
      router.refresh();
    } catch (err) {
      setMsg({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="field">
        <span className="label">Type</span>
        <div className="segmented" role="group">
          <button type="button" aria-pressed={direction === "credit"} onClick={() => setDirection("credit")}>Credit (+)</button>
          <button type="button" aria-pressed={direction === "debit"} onClick={() => setDirection("debit")}>Debit (−)</button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="adj-credits">Credits</label>
        <input id="adj-credits" type="number" min={1} step={1} value={credits} onChange={(e) => setCredits(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="adj-reason">Reason (required, saved to the audit log)</label>
        <textarea id="adj-reason" rows={2} minLength={5} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} required />
      </div>
      {msg && <div className={`alert ${msg.tone}`} role="status">{msg.text}</div>}
      <button className="btn btn-primary" disabled={!valid || busy} type="submit">{busy ? <span className="spinner" /> : null} {direct ? "Apply adjustment" : "Request adjustment"}</button>
      <p className="hint mt mb-0">{direct ? "Super Admin: applied immediately; debits cannot exceed the available balance." : "Admin: a second admin must approve (two-person rule)."}</p>
    </form>
  );
}

export function RoleControl({ userId, role }: { userId: string; role: string }) {
  const router = useRouter();
  const [value, setValue] = useState(role);
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    if (value === role) return;
    if (!confirm(`Change role from ${role} to ${value}?`)) return;
    try {
      await api(`/api/admin/users/${userId}`, { method: "POST", json: { action: "role", role: value, confirm: true } });
      setMsg("Role updated.");
      router.refresh();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }
  return (
    <div>
      <div className="row">
        <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Role" style={{ maxWidth: 220 }}>
          <option value="user">User</option>
          <option value="admin">Admin</option>
          <option value="super_admin">Super Admin</option>
        </select>
        <button className="btn btn-secondary" onClick={save} disabled={value === role}>Save role</button>
      </div>
      {msg && <p className="small mt mb-0" role="status">{msg}</p>}
      <p className="hint mt mb-0">Admin: dashboards, users, top-up verification, adjustment requests, templates. Super Admin: also roles, settings, SMS pricing/templates and direct adjustments.</p>
    </div>
  );
}
