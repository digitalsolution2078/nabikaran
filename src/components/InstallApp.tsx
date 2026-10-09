"use client";
import { useEffect, useState } from "react";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";
import { INSTALL_EVENT } from "./SwRegister";

type Mode = "hidden" | "prompt" | "ios" | "installed";
const DISMISS_KEY = "nb-install-dismissed";

function detect(): Mode {
  if (typeof window === "undefined") return "hidden";
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone) return "installed";
  if (window.__nbInstall) return "prompt";
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return iOS && safari ? "ios" : "hidden";
}

/** "Install the app" — a card in Settings, or a dismissible banner on the dashboard. */
export function InstallApp({ variant }: { variant: "card" | "banner" }) {
  const { t } = usePrefs();
  const [mode, setMode] = useState<Mode>("hidden");
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    const update = () => setMode(detect());
    update();
    try { setDismissed(localStorage.getItem(DISMISS_KEY) === "1"); } catch { setDismissed(false); }
    window.addEventListener(INSTALL_EVENT, update);
    return () => window.removeEventListener(INSTALL_EVENT, update);
  }, []);

  const install = async () => {
    const ev = window.__nbInstall;
    if (!ev) return;
    await ev.prompt();
    await ev.userChoice.catch(() => undefined);
    window.__nbInstall = null;
    setMode(detect());
  };
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ }
  };

  if (variant === "banner" && (dismissed || mode === "hidden" || mode === "installed")) return null;
  if (variant === "card" && mode === "hidden") {
    return (
      <div className="card">
        <h2>{t("pwa.title")}</h2>
        <p className="muted mb-0">{t("pwa.otherBrowser")}</p>
      </div>
    );
  }

  const body = mode === "installed" ? (
    <p className="mb-0">{t("pwa.installed")}</p>
  ) : mode === "ios" ? (
    <p className="mb-0">{t("pwa.iosSteps")}</p>
  ) : (
    <p className="mb-0">{t("pwa.benefit")}</p>
  );

  if (variant === "banner") {
    return (
      <div className="alert install-banner" role="region" aria-label={t("pwa.title")}>
        <Icon name="phone" size={20} />
        <div className="install-text">
          <strong>{t("pwa.title")}</strong>
          <p className="mb-0">{mode === "ios" ? t("pwa.iosSteps") : t("pwa.bannerShort")}</p>
        </div>
        <div className="row install-actions">
          {mode === "prompt" && <button type="button" className="btn btn-primary" onClick={install}>{t("pwa.install")}</button>}
          <button type="button" className="btn btn-ghost" onClick={dismiss} aria-label={t("pwa.dismiss")}>{t("pwa.dismiss")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>{t("pwa.title")}</h2>
      {body}
      {mode === "prompt" && <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={install}>{t("pwa.install")}</button>}
    </div>
  );
}
