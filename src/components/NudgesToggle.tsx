"use client";
import { useState } from "react";
import { api } from "./api";
import { usePrefs } from "./Prefs";

/** Settings: turn the "set your first reminder" tips on or off. */
export function NudgesToggle({ initial }: { initial: boolean }) {
  const { t } = usePrefs();
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function change(v: boolean) {
    setBusy(true);
    try {
      await api("/api/me", { method: "PATCH", json: { nudges: v } });
      setOn(v);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>{t("nudge.title")}</h2>
      <label className="row small"><input type="checkbox" checked={on} disabled={busy} onChange={(e) => change(e.target.checked)} /> {t("nudge.label")}</label>
      <p className="hint mb-0">{t("nudge.hint")}</p>
    </section>
  );
}
