"use client";
import { useState } from "react";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

interface Status { enabled: boolean; hasPin: boolean; locked: boolean; setAt: string | null; staff: boolean }

const pinInput = (id: string, label: string, value: string, set: (v: string) => void, autoComplete = "new-password") => (
  <div className="field">
    <label htmlFor={id}>{label}</label>
    <input id={id} type="password" inputMode="numeric" autoComplete={autoComplete} maxLength={6} value={value} onChange={(e) => set(e.target.value.replace(/\D/g, ""))} style={{ letterSpacing: "0.3em" }} />
  </div>
);

export function PinManager({ initial }: { initial: Status }) {
  const { t } = usePrefs();
  const [st, setSt] = useState<Status>(initial);
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!st.enabled || st.staff) {
    return (
      <section className="card">
        <h2>{t("pin.title")}</h2>
        <p className="muted mb-0">{st.staff ? t("pin.staff") : t("pin.off")}</p>
      </section>
    );
  }

  async function save() {
    if (pin !== pin2) return setMsg({ ok: false, text: t("pin.mismatch") });
    setBusy(true);
    setMsg(null);
    try {
      setSt(await api<Status>("/api/me/pin", { method: "POST", json: { pin, currentPin: st.hasPin && !st.locked ? cur : null } }));
      setMsg({ ok: true, text: t("pin.saved") });
      setOpen(false);
      setCur(""); setPin(""); setPin2("");
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setMsg(null);
    try {
      setSt(await api<Status>("/api/me/pin", { method: "DELETE", json: { currentPin: cur } }));
      setMsg({ ok: true, text: t("pin.removed") });
      setOpen(false);
      setCur("");
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="row between">
        <h2 className="mb-0">{t("pin.title")}</h2>
        <span className={`badge ${st.hasPin ? (st.locked ? "warn" : "ok") : ""}`}>{st.hasPin ? (st.locked ? t("pin.locked") : t("pin.on")) : t("pin.notSet")}</span>
      </div>
      <p className="small muted mt">{t("pin.body")}</p>
      {st.locked && <div className="alert warn"><Icon name="lock" /> <span>{t("pin.lockedBody")}</span></div>}
      {msg && <div className={`alert ${msg.ok ? "ok" : "bad"}`} role="status"><span>{msg.text}</span></div>}
      {!open ? (
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}><Icon name="lock" size={16} /> {st.hasPin ? t("pin.change") : t("pin.set")}</button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label={t("pin.title")}>
          <input type="text" name="username" autoComplete="username" hidden readOnly value="" />
          <div className="grid grid-3">
            {st.hasPin && !st.locked && pinInput("pin-cur", t("pin.current"), cur, setCur, "current-password")}
            {pinInput("pin-new", t("pin.new"), pin, setPin)}
            {pinInput("pin-new2", t("pin.confirm"), pin2, setPin2)}
          </div>
          <p className="hint">{t("pin.rules")}</p>
          <div className="row between">
            <div className="row">
              <button type="button" className="btn btn-secondary" onClick={() => { setOpen(false); setMsg(null); }}>{t("rem.back")}</button>
              {st.hasPin && <button type="button" className="btn btn-ghost" disabled={busy || (!st.locked && cur.length < 4)} onClick={remove}>{t("pin.remove")}</button>}
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || pin.length < 4 || pin2.length < 4}>{t("pin.savePin")}</button>
          </div>
        </form>
      )}
    </section>
  );
}
