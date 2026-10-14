"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

/** Settings: business tools (reminders for your clients). */
export function BusinessCard({ initial }: { initial: string | null }) {
  const router = useRouter();
  const { t } = usePrefs();
  const [name, setName] = useState(initial ?? "");
  const [on, setOn] = useState(Boolean(initial));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function save(next: string | null) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ businessName: string | null }>("/api/me/business", { method: "PUT", json: { businessName: next } });
      setOn(Boolean(r.businessName));
      setMsg({ tone: "ok", text: t("settings.saved") });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" id="business">
      <h2><Icon name="briefcase" /> {t("biz.title")}</h2>
      <p className="small muted">{t("biz.lead")}</p>
      <div className="field">
        <label htmlFor="biz-name">{t("biz.name")}</label>
        <input id="biz-name" type="text" maxLength={20} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ram Motors" />
        <span className="hint">{t("biz.nameHint")}</span>
      </div>
      {msg && <div className={`alert ${msg.tone}`} role="status">{msg.text}</div>}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-primary" disabled={busy || name.trim().length < 2} onClick={() => save(name.trim())}>{on ? t("biz.save") : t("biz.turnOn")}</button>
        {on && <Link href="/clients" className="btn btn-secondary">{t("biz.open")} →</Link>}
        {on && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => save(null)}>{t("biz.turnOff")}</button>}
      </div>
    </section>
  );
}
