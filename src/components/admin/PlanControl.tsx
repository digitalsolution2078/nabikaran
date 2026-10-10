"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import type { PlanHistoryRow } from "@/lib/services/plans";

/** Super admin: give, extend or end Pro for one customer. */
export function PlanControl({ userId, history, canGrant }: { userId: string; history: PlanHistoryRow[]; canGrant: boolean }) {
  const router = useRouter();
  const [days, setDays] = useState("30");
  const [withAllowances, setWithAllowances] = useState(false);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const active = history.filter((h) => h.status === "active" && new Date(h.endsAt).getTime() > now);

  const post = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/admin/users/${userId}/plan`, { method: "POST", json: body });
      setMsg({ tone: "ok", text: ok });
      setNote("");
      router.refresh();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {history.length === 0 ? <p className="muted">Basic (never had Pro).</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Plan</th><th>From</th><th>Until</th><th className="num">Paid</th><th></th></tr></thead>
            <tbody>
              {history.map((h) => {
                const live = h.status === "active" && new Date(h.endsAt).getTime() > now;
                return (
                  <tr key={h.id}>
                    <td>{h.kind}{h.status === "revoked" ? " (ended by admin)" : ""}{h.note ? <><br /><span className="small muted">{h.note}</span></> : null}</td>
                    <td>{h.startsAt.slice(0, 10)}</td>
                    <td>{h.endsAt.slice(0, 10)}</td>
                    <td className="num">{h.priceCredits}</td>
                    <td>{canGrant && live && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { const reason = window.prompt("Reason for ending this plan now? (No refund is made.)"); if (reason && reason.trim().length >= 3) post({ action: "revoke", planId: h.id, reason: reason.trim() }, "Plan ended."); }}>End now</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {canGrant && (
        <div className="mt">
          <h3>{active.length ? "Extend Pro" : "Give Pro"}</h3>
          <div className="grid grid-2">
            <div className="field"><label htmlFor="pc-days">Days</label><input id="pc-days" type="number" min={1} max={730} value={days} onChange={(e) => setDays(e.target.value)} /></div>
            <div className="field"><span className="label">Included messages</span><label className="row small"><input type="checkbox" checked={withAllowances} onChange={(e) => setWithAllowances(e.target.checked)} /> Include the plan&apos;s SMS / WhatsApp / email allowance</label></div>
          </div>
          <div className="field"><label htmlFor="pc-note">Reason (kept in the audit log)</label><input id="pc-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Launch partner, support goodwill, paid offline…" /></div>
          <button type="button" className="btn btn-secondary" disabled={busy || note.trim().length < 3 || !(Number(days) >= 1)} onClick={() => post({ action: "grant", days: Number(days), withAllowances, note: note.trim() }, "Pro given.")}>{active.length ? "Add days" : "Give Pro"}</button>
        </div>
      )}
      {msg && <div className={`alert ${msg.tone} mt`} role="status">{msg.text}</div>}
    </div>
  );
}
