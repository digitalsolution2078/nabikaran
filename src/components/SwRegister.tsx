"use client";
import { useEffect } from "react";

/** Chrome fires `beforeinstallprompt` once, often before React mounts the install button; keep it for later. */
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
declare global {
  interface Window { __nbInstall?: InstallPromptEvent | null }
}
export const INSTALL_EVENT = "nb-install-available";

export function SwRegister() {
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      window.__nbInstall = e as InstallPromptEvent;
      window.dispatchEvent(new Event(INSTALL_EVENT));
    };
    const onInstalled = () => {
      window.__nbInstall = null;
      window.dispatchEvent(new Event(INSTALL_EVENT));
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return null;
}
