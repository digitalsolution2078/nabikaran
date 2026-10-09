"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import type { Lang } from "@/lib/i18n/dict";
import type { DateFormat } from "@/lib/i18n/format";

export function SettingsForm({ displayName, smsLanguage }: { displayName: string; smsLanguage: string }) {
  const router = useRouter();
  const { t, prefs, setPrefs } = usePrefs();
  const [name, setName] = useState(displayName);
  const [lang, setLang] = useState<Lang>(prefs.lang);
  const [date, setDate] = useState<DateFormat>(prefs.date);
  const [sms, setSms] = useState<"en-NP" | "ne-NP">(smsLanguage === "en-NP" ? "en-NP" : "ne-NP");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/me", { method: "PATCH", json: { displayName: name } });
      await setPrefs({ lang, date, smsLanguage: sms });
      setMsg(t("settings.saved"));
      router.refresh();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function exportData() {
    const data = await api("/api/me", { method: "POST", json: { action: "export" } });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "nabikaran-export.json";
    a.click();
  }
  async function closeAccount() {
    if (!confirm(t("settings.closeConfirm"))) return;
    await api("/api/me", { method: "POST", json: { action: "delete" } });
    router.push("/");
    router.refresh();
  }
  return (
    <>
      <form onSubmit={save} className="card">
        <h2>{t("settings.profile")}</h2>
        <div className="field">
          <label htmlFor="name">{t("settings.name")}</label>
          <input id="name" type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </div>
        <h2 className="mt">{t("settings.preferences")}</h2>
        <div className="grid grid-3">
          <div className="field">
            <span className="label">{t("prefs.language")}</span>
            <div className="segmented" role="group">
              <button type="button" aria-pressed={lang === "ne"} onClick={() => setLang("ne")}>नेपाली</button>
              <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")}>English</button>
            </div>
          </div>
          <div className="field">
            <span className="label">{t("prefs.dateFormat")}</span>
            <div className="segmented" role="group">
              <button type="button" aria-pressed={date === "BS"} onClick={() => setDate("BS")}>BS</button>
              <button type="button" aria-pressed={date === "AD"} onClick={() => setDate("AD")}>AD</button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="sms">{t("prefs.smsLanguage")}</label>
            <select id="sms" value={sms} onChange={(e) => setSms(e.target.value as "en-NP" | "ne-NP")}>
              <option value="ne-NP">{t("prefs.smsNeRoman")}</option>
              <option value="en-NP">{t("prefs.smsEn")}</option>
            </select>
          </div>
        </div>
        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? <span className="spinner" /> : null} {t("settings.save")}</button>
          {msg && <span className="muted" role="status">{msg}</span>}
        </div>
      </form>
      <section className="card">
        <h2>{t("settings.data")}</h2>
        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={exportData}>{t("settings.export")}</button>
          <button type="button" className="btn btn-ghost" style={{ color: "var(--bad)" }} onClick={closeAccount}>{t("settings.close")}</button>
        </div>
      </section>
    </>
  );
}
