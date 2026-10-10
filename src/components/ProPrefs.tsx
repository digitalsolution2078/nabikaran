"use client";
import { useState } from "react";
import { api } from "./api";
import { usePrefs } from "./Prefs";

/** Pro: use wallet credits without asking once included messages run out (off by default). */
export function ProPrefs({ initial }: { initial: { creditFallback: boolean } }) {
  const { t } = usePrefs();
  const [on, setOn] = useState(initial.creditFallback);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <section className="card">
      <h2>{t("pro.prefs.title")}</h2>
      <label className="row small">
        <input type="checkbox" checked={on} onChange={async (e) => {
          const v = e.target.checked;
          setOn(v);
          setMsg(null);
          try {
            await api("/api/pro", { method: "POST", json: { action: "prefs", creditFallback: v } });
            setMsg(t("pro.prefs.saved"));
          } catch (err) {
            setOn(!v);
            setMsg((err as Error).message);
          }
        }} />
        <span>{t("pro.prefs.fallback")}</span>
      </label>
      {msg && <p className="hint mb-0">{msg}</p>}
    </section>
  );
}
