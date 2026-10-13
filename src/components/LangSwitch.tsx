"use client";
import { usePrefs } from "./Prefs";

/** Two-option language switch with a sliding thumb: English | नेपाली. */
export function LangSwitch({ compact = false }: { compact?: boolean }) {
  const { prefs, setPrefs, t } = usePrefs();
  const set = (lang: "en" | "ne") => { if (lang !== prefs.lang) void setPrefs({ ...prefs, lang }); };
  return (
    <div className={`lang-switch${prefs.lang === "ne" ? " is-ne" : ""}`} role="group" aria-label={`${t("lang.switch")} · Language`}>
      <span className="thumb" aria-hidden />
      <button type="button" lang="en" aria-pressed={prefs.lang === "en"} onClick={() => set("en")}>{compact ? "EN" : "English"}</button>
      <button type="button" lang="ne" aria-pressed={prefs.lang === "ne"} onClick={() => set("ne")}>{compact ? "ने" : "नेपाली"}</button>
    </div>
  );
}
