"use client";
import { useState } from "react";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";
import type { CalendarLink } from "@/lib/services/calendar";

/** Pro: show reminders in Google Calendar, Apple Calendar or Outlook via a private feed link. */
export function CalendarSync({ initial }: { initial: CalendarLink }) {
  const { t } = usePrefs();
  const [link, setLink] = useState<CalendarLink>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const turnOn = (reset = false) =>
    run(async () => {
      if (reset && !window.confirm(t("cal.resetConfirm"))) return;
      setLink(await api<CalendarLink>("/api/me/calendar", { method: "POST", json: { reset } }));
      if (reset) setMsg({ ok: true, text: t("cal.resetDone") });
    });
  const turnOff = () =>
    run(async () => {
      if (!window.confirm(t("cal.offConfirm"))) return;
      setLink(await api<CalendarLink>("/api/me/calendar", { method: "DELETE" }));
    });
  const copy = () =>
    run(async () => {
      await navigator.clipboard.writeText(link.url ?? "");
      setMsg({ ok: true, text: t("cal.copied") });
    });

  return (
    <section className="card" id="calendar" aria-labelledby="cal-h">
      <h2 id="cal-h"><Icon name="calendar" size={18} /> {t("cal.title")} <span className="badge info">Pro</span></h2>
      <p className="muted">{t("cal.intro")}</p>
      {!link.enabled ? (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => turnOn(false)}>
          {busy ? <span className="spinner" /> : <Icon name="calendar" size={16} />} {t("cal.enable")}
        </button>
      ) : (
        <>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <a className="btn btn-primary" href={link.google ?? "#"} target="_blank" rel="noopener noreferrer"><Icon name="calendar" size={16} /> {t("cal.google")}</a>
            <a className="btn btn-outline" href={link.webcal ?? "#"}>{t("cal.apple")}</a>
            <a className="btn btn-outline" href={link.outlook ?? "#"} target="_blank" rel="noopener noreferrer">{t("cal.outlook")}</a>
          </div>
          <div className="field">
            <label htmlFor="cal-url">{t("cal.link")}</label>
            <div className="row" style={{ gap: 6 }}>
              <input id="cal-url" type="text" value={link.url ?? ""} readOnly onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={copy}><Icon name="copy" size={14} /> {t("cal.copy")}</button>
            </div>
            <span className="hint">{t("cal.private")}</span>
          </div>
          <details className="small">
            <summary>{t("cal.howTitle")}</summary>
            <ol className="small">
              <li>{t("cal.howGoogle")}</li>
              <li>{t("cal.howPhone")}</li>
              <li>{t("cal.howDelay")}</li>
            </ol>
          </details>
          <div className="row mt" style={{ gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => turnOn(true)}>{t("cal.reset")}</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={turnOff}>{t("cal.off")}</button>
          </div>
        </>
      )}
      {msg && <div className={`alert ${msg.ok ? "ok" : "bad"} mt`} role="status">{msg.text}</div>}
    </section>
  );
}
