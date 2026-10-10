"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

/** Pro: record a completed renewal; a one-time reminder moves to the new expiry date. */
export function MarkRenewed({ id, repeats, calendar, suggestedNext, currency = "NPR" }: { id: string; repeats: boolean; calendar: "AD" | "BS"; suggestedNext: string; currency?: string }) {
  const { t } = usePrefs();
  const router = useRouter();
  const today = new Date(Date.now() + 345 * 60_000).toISOString().slice(0, 10);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ on: today, amount: "", next: suggestedNext, note: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [permission, setPermission] = useState<number | null>(null);
  const [useCredits, setUseCredits] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/renewals/${id}/renewed`, { method: "POST", json: {
        renewedOn: f.on, amount: f.amount === "" ? null : Number(f.amount), currency, note: f.note.trim() || null,
        nextExpiryDate: repeats ? null : f.next, useCredits,
      } });
      setMsg({ ok: true, text: t("renew.saved") });
      setOpen(false);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "credits_permission_required") setPermission(Number(err.detail?.credits ?? 1));
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}><Icon name="check" size={14} /> {t("renew.title")}</button>
        {msg?.ok && <span className="small" style={{ color: "var(--ok)" }}> {msg.text}</span>}
      </>
    );
  }
  return (
    <form onSubmit={save} className="card" style={{ width: "100%", marginTop: 10 }}>
      <h3 style={{ marginTop: 0 }}>{t("renew.title")}</h3>
      {repeats && <p className="hint">{t("renew.repeatNote")}</p>}
      <div className="grid grid-2">
        <div className="field"><label htmlFor="rn-on">{t("renew.on")}</label><input id="rn-on" type="date" value={f.on} onChange={(e) => setF({ ...f, on: e.target.value })} required /></div>
        <div className="field"><label htmlFor="rn-amt">{t("renew.cost")} ({currency})</label><input id="rn-amt" type="number" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
        {!repeats && (
          <div className="field">
            <label htmlFor="rn-next">{t("renew.next")} ({calendar})</label>
            <input id="rn-next" type="text" inputMode="numeric" placeholder="YYYY-MM-DD" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required pattern="\d{4}-\d{2}-\d{2}" />
          </div>
        )}
        <div className="field"><label htmlFor="rn-note">{t("renew.note")}</label><input id="rn-note" type="text" maxLength={200} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
      </div>
      {permission !== null && <label className="row small alert pro"><input type="checkbox" checked={useCredits} onChange={(e) => setUseCredits(e.target.checked)} /> <span>{t("rem.useCredits", { credits: permission })}</span></label>}
      {msg && !msg.ok && <div className="alert bad">{msg.text}</div>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-sm" disabled={busy || (permission !== null && !useCredits)}>{busy ? <span className="spinner" /> : null} {t("renew.save")}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>{t("rem.back")}</button>
      </div>
    </form>
  );
}
