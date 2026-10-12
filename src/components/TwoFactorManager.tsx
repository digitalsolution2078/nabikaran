"use client";
import { useState } from "react";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";
import type { TwoFactorStatus } from "@/lib/services/two-factor";

/** Settings: turn the authenticator app on / off, recovery codes. */
export function TwoFactorManager({ initial }: { initial: TwoFactorStatus }) {
  const { t } = usePrefs();
  const [st, setSt] = useState(initial);
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"none" | "disable" | "recovery">("none");
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
  const start = () => run(async () => setSetup(await api<{ secret: string; qrSvg: string }>("/api/me/2fa", { method: "POST", json: { action: "setup" } })));
  const confirm = () => run(async () => {
    const r = await api<{ recoveryCodes: string[] }>("/api/me/2fa", { method: "POST", json: { action: "confirm", code } });
    setCodes(r.recoveryCodes);
    setSetup(null);
    setCode("");
    setSt({ enabled: true, enabledAt: new Date().toISOString(), recoveryLeft: r.recoveryCodes.length });
    setMsg({ ok: true, text: t("tfa.on") });
  });
  const disable = () => run(async () => {
    setSt(await api<TwoFactorStatus>("/api/me/2fa", { method: "POST", json: { action: "disable", code } }));
    setCode("");
    setMode("none");
    setCodes(null);
    setMsg({ ok: true, text: t("tfa.off") });
  });
  const regenerate = () => run(async () => {
    const r = await api<{ recoveryCodes: string[] }>("/api/me/2fa", { method: "POST", json: { action: "recovery", code } });
    setCodes(r.recoveryCodes);
    setSt({ ...st, recoveryLeft: r.recoveryCodes.length });
    setCode("");
    setMode("none");
  });
  const copy = () => navigator.clipboard.writeText((codes ?? []).join("\n")).catch(() => undefined);

  return (
    <section className="card" id="two-factor" aria-labelledby="tfa-h">
      <h2 id="tfa-h"><Icon name="lock" size={18} /> {t("tfa.title")} {st.enabled && <span className="badge ok">{t("tfa.badgeOn")}</span>}</h2>
      <p className="muted">{t("tfa.intro")}</p>

      {codes && (
        <div className="alert warn" style={{ display: "block" }}>
          <strong>{t("tfa.saveCodes")}</strong>
          <pre className="mono" style={{ margin: "8px 0", whiteSpace: "pre-wrap" }}>{codes.join("\n")}</pre>
          <button type="button" className="btn btn-ghost btn-sm" onClick={copy}><Icon name="copy" size={14} /> {t("cal.copy")}</button>
        </div>
      )}

      {!st.enabled && !setup && <button type="button" className="btn btn-primary" disabled={busy} onClick={start}>{t("tfa.enable")}</button>}

      {setup && (
        <div className="grid grid-2" style={{ alignItems: "start" }}>
          <div>
            <ol className="small">
              <li>{t("tfa.step1")}</li>
              <li>{t("tfa.step2")}</li>
              <li>{t("tfa.step3")}</li>
            </ol>
            <div className="qr-box" role="img" aria-label="QR" style={{ maxWidth: 220 }} dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
            <p className="hint">{t("tfa.manual")} <span className="mono">{setup.secret}</span></p>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); confirm(); }}>
            <div className="field">
              <label htmlFor="tfa-setup-code">{t("tfa.appCode")}</label>
              <input id="tfa-setup-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ fontSize: 22, letterSpacing: "0.3em", textAlign: "center" }} />
            </div>
            <button className="btn btn-primary" disabled={busy || code.length !== 6}>{busy ? <span className="spinner" /> : t("tfa.turnOn")}</button>
          </form>
        </div>
      )}

      {st.enabled && !codes && (
        <>
          <p className="small">{t("tfa.recoveryLeft", { n: st.recoveryLeft })}</p>
          {mode === "none" ? (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setMode("recovery"); setCode(""); }}>{t("tfa.newCodes")}</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setMode("disable"); setCode(""); }}>{t("tfa.disable")}</button>
            </div>
          ) : (
            <form className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); if (mode === "disable") disable(); else regenerate(); }}>
              <div className="field mb-0">
                <label htmlFor="tfa-manage-code">{mode === "disable" ? t("tfa.codeOrRecovery") : t("tfa.appCode")}</label>
                <input id="tfa-manage-code" autoComplete="one-time-code" maxLength={mode === "disable" ? 20 : 6} value={code} onChange={(e) => setCode(mode === "disable" ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ""))} />
              </div>
              <button className={`btn ${mode === "disable" ? "btn-danger" : "btn-primary"}`} disabled={busy || code.length < 6}>{mode === "disable" ? t("tfa.disable") : t("tfa.newCodes")}</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode("none")}>{t("common.cancel")}</button>
            </form>
          )}
        </>
      )}
      {codes && st.enabled && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCodes(null)}>{t("tfa.savedThem")}</button>}
      {msg && <div className={`alert ${msg.ok ? "ok" : "bad"} mt`} role="status">{msg.text}</div>}
    </section>
  );
}
