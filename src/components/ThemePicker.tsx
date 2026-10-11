"use client";
import { useState } from "react";
import { usePrefs } from "./Prefs";
import { THEME_COOKIE, type Theme } from "@/lib/theme";

/** Settings → Appearance: light (brand, default), dark, or follow the device. */
export function ThemePicker({ initial }: { initial: Theme }) {
  const { t } = usePrefs();
  const [theme, setTheme] = useState<Theme>(initial);
  const choose = (v: Theme) => {
    setTheme(v);
    document.documentElement.setAttribute("data-theme", v);
    document.cookie = `${THEME_COOKIE}=${v}; path=/; max-age=${365 * 24 * 3600}; samesite=lax`;
  };
  return (
    <section className="card">
      <h2>{t("theme.title")}</h2>
      <div className="segmented" role="group" aria-label={t("theme.title")}>
        {(["light", "dark", "system"] as Theme[]).map((v) => (
          <button key={v} type="button" aria-pressed={theme === v} onClick={() => choose(v)}>{t(`theme.${v}`)}</button>
        ))}
      </div>
      <p className="hint mb-0">{t("theme.hint")}</p>
    </section>
  );
}
