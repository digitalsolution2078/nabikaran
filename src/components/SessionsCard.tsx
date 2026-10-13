"use client";
import { useState } from "react";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

/** Settings: sign out of every other phone and browser (lost phone, shared computer). */
export function SessionsCard() {
  const { t } = usePrefs();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function go() {
    if (!confirm(t("sess.confirm"))) return;
    setBusy(true);
    const res = await fetch("/api/me/sessions", { method: "POST", credentials: "same-origin" });
    setBusy(false);
    setDone(res.ok);
  }
  return (
    <section className="card" id="sessions">
      <h2>{t("sess.title")}</h2>
      <p className="muted">{t("sess.text")}</p>
      {done ? (
        <div className="alert ok mb-0"><Icon name="check" /> <span>{t("sess.done")}</span></div>
      ) : (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={go}>{busy ? <span className="spinner" /> : <Icon name="logout" size={16} />} {t("sess.button")}</button>
      )}
    </section>
  );
}
