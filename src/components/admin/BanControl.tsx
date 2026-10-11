"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import type { BanInfo } from "@/lib/services/bans";

const DURATIONS: Array<[string, number | null]> = [["Permanent (until unbanned)", null], ["7 days", 7], ["30 days", 30], ["90 days", 90]];
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

/** Admin: ban (suspend) or unban a customer. Data and history are kept. */
export function BanControl({ userId, info, canBan, isStaff }: { userId: string; info: BanInfo; canBan: boolean; isStaff: boolean }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [days, setDays] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function act(action: "ban" | "unban") {
    const q = action === "ban"
      ? `Ban this account${days ? ` for ${days} days` : " until you unban it"}?\n\nThey are signed out, cannot sign in or use ChatGPT/Claude, and no messages are sent. Reminders, wallet and history are kept.`
      : "Unban this account? They can sign in again and their paused reminders resume (if their wallet covers them).";
    if (!window.confirm(q)) return;
    setBusy(true);
    setMsg(null);
    try {
      const until = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
      const r = await api<BanInfo & { resumed?: number; notResumed?: number }>(`/api/admin/users/${userId}`, {
        method: "POST",
        json: action === "ban" ? { action, reason, until, confirm: true } : { action, note: note.trim() || null, confirm: true },
      });
      setMsg({ ok: true, text: action === "ban" ? "Account banned." : `Account unbanned. ${r.resumed ?? 0} reminder(s) resumed${r.notResumed ? `, ${r.notResumed} left paused (not enough credits)` : ""}.` });
      setReason("");
      setNote("");
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {info.banned ? (
        <div className="alert bad" style={{ display: "block" }}>
          <strong>Banned</strong> since {fmt(info.bannedAt)}{info.bannedBy ? ` by ${info.bannedBy}` : ""}{info.until ? ` · ends ${fmt(info.until)}` : " · permanent"}
          {info.reason && <><br />Reason: {info.reason}</>}
        </div>
      ) : <p className="muted">Banning signs the customer out and blocks sign-in (SMS code, PIN, email), ChatGPT / Claude access and all messages. Nothing is deleted: reminders, wallet, payments and history stay, and an unban restores them.</p>}
      {!canBan ? <p className="muted small mb-0">Only an admin or Super Admin can ban accounts.</p> : isStaff ? <p className="muted small mb-0">Staff accounts cannot be banned. Change the role to Customer first.</p> : info.banned ? (
        <div className="row mt" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field mb-0 grow" style={{ minWidth: 200 }}><label htmlFor="unban-note">Note (optional)</label><input id="unban-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></div>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act("unban")}>Unban</button>
        </div>
      ) : (
        <div className="mt">
          <div className="field"><label htmlFor="ban-reason">Reason (kept in the history; not shown to the customer)</label><input id="ban-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Payment fraud, abusive use, spam" /></div>
          <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div className="field mb-0"><label htmlFor="ban-days">Duration</label>
              <select id="ban-days" value={days ?? ""} onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)}>
                {DURATIONS.map(([l, d]) => <option key={l} value={d ?? ""}>{l}</option>)}
              </select>
            </div>
            <button type="button" className="btn btn-danger" disabled={busy || reason.trim().length < 5} onClick={() => act("ban")}>Ban account</button>
          </div>
        </div>
      )}
      {msg && <div className={`alert ${msg.ok ? "ok" : "bad"} mt`} role="status">{msg.text}</div>}
      {info.history.length > 0 && (
        <details className="mt small">
          <summary>Ban history ({info.history.length})</summary>
          <ul>
            {info.history.map((h, i) => <li key={i}>{fmt(h.at)} · <strong>{h.action}</strong>{h.actor ? ` by ${h.actor}` : " (automatic)"}{h.until ? ` until ${fmt(h.until)}` : ""}{h.reason ? ` — ${h.reason}` : ""}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
