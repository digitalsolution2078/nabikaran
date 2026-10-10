"use client";
import { useEffect, useState } from "react";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

type State = "loading" | "unsupported" | "ios-install" | "denied" | "off" | "on";

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Free phone / browser notifications for reminders (web push). */
export function PushManager() {
  const { t } = usePrefs();
  const [state, setState] = useState<State>("loading");
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setState(ios && !standalone ? "ios-install" : "unsupported");
        return;
      }
      try {
        const r = await api<{ devices: number }>("/api/me/push");
        setDevices(r.devices);
      } catch {
        /* ignore */
      }
      if (Notification.permission === "denied") return setState("denied");
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setState(sub ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);

  async function enable() {
    setBusy(true);
    setMsg(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "denied" : "off");
        return;
      }
      const { publicKey } = await api<{ publicKey: string }>("/api/me/push");
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      const r = await api<{ devices: number }>("/api/me/push", { method: "POST", json: { subscription: sub.toJSON() } });
      setDevices(r.devices);
      setState("on");
      setMsg({ ok: true, text: t("push.enabled") });
    } catch (e) {
      // e.g. private / incognito windows, or a browser without a push service.
      setMsg({ ok: false, text: e instanceof DOMException ? t("push.subscribeFailed") : (e as Error).message || t("push.failed") });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setMsg(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      const endpoint = sub?.endpoint ?? null;
      await sub?.unsubscribe();
      const r = await api<{ devices: number }>("/api/me/push", { method: "DELETE", json: { endpoint } });
      setDevices(r.devices);
      setState("off");
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ reached: number }>("/api/me/push", { method: "PUT", json: { body: t("push.testBody") } });
      setMsg(r.reached > 0 ? { ok: true, text: t("push.testSent") } : { ok: false, text: t("push.failed") });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="push-h">
      <h2 id="push-h"><Icon name="bell" size={18} /> {t("push.title")}</h2>
      <p className="muted">{t("push.intro")}</p>
      {state === "unsupported" && <p className="hint mb-0">{t("push.unsupported")}</p>}
      {state === "ios-install" && <p className="hint mb-0">{t("push.iosInstall")}</p>}
      {state === "denied" && <p className="hint mb-0">{t("push.denied")}</p>}
      {(state === "off" || state === "on") && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {state === "off" ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={enable}>{busy ? <span className="spinner" /> : <Icon name="bell" size={16} />} {t("push.enable")}</button>
          ) : (
            <>
              <span className="badge ok">{t("push.onThisDevice")}</span>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={test}>{t("push.test")}</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={disable}>{t("push.disable")}</button>
            </>
          )}
        </div>
      )}
      {devices > 0 && <p className="hint">{t("push.devices", { n: devices })}</p>}
      {msg && <div className={`alert ${msg.ok ? "ok" : "bad"} mt`} role="status">{msg.text}</div>}
    </section>
  );
}
