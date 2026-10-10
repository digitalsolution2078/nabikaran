"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

export function OtpForm({ next, fee = 1, pinEnabled = false, refCode = null }: { next?: string | null; fee?: number; pinEnabled?: boolean; refCode?: string | null }) {
  const router = useRouter();
  const { t } = usePrefs();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"phone" | "code" | "pin">("phone");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);

  async function request(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ phone: string; devCode?: string }>("/api/auth/otp/request", { method: "POST", json: { phone } });
      setPhone(r.phone);
      setDevCode(r.devCode ?? null);
      setStep("code");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ next: string }>("/api/auth/otp/verify", { method: "POST", json: { phone, code, ...(refCode ? { ref: refCode } : {}) } });
      router.push(next ?? r.next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function pinLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ next: string }>("/api/auth/pin", { method: "POST", json: { phone, pin } });
      router.push(next ?? r.next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setPin("");
      setBusy(false);
    }
  }

  if (step === "pin") {
    return (
      <form onSubmit={pinLogin} noValidate>
        <div className="field">
          <label htmlFor="pin-phone">{t("login.phone")}</label>
          <div className="input-affix">
            <span>+977</span>
            <input id="pin-phone" inputMode="tel" autoComplete="username" placeholder="98XXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </div>
        </div>
        <div className="field">
          <label htmlFor="pin">{t("pin.label")}</label>
          <input id="pin" type="password" inputMode="numeric" autoComplete="current-password" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} style={{ fontSize: 20, letterSpacing: "0.4em", textAlign: "center" }} required />
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
        <button className="btn btn-primary btn-block btn-lg" disabled={busy || phone.replace(/\D/g, "").length < 10 || pin.length < 4} type="submit">
          {busy ? <span className="spinner" /> : t("pin.signIn")}
        </button>
        <p className="hint mt mb-0">{t("pin.loginHint")}</p>
        <button type="button" className="btn btn-ghost btn-block mt" onClick={() => { setStep("phone"); setPin(""); setError(null); }}>{t("pin.useSms")}</button>
      </form>
    );
  }

  if (step === "phone") {
    return (
      <form onSubmit={request} noValidate>
        <div className="field">
          <label htmlFor="phone">{t("login.phone")}</label>
          <div className="input-affix">
            <span>+977</span>
            <input id="phone" inputMode="tel" autoComplete="tel-national" placeholder="98XXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "otp-err" : undefined} required />
          </div>
        </div>
        {error && <p className="field-error" id="otp-err" role="alert">{error}</p>}
        <button className="btn btn-primary btn-block btn-lg" disabled={busy || phone.replace(/\D/g, "").length < 10} type="submit">
          {busy ? <><span className="spinner" /> {t("login.sending")}</> : t("login.send")}
        </button>
        <p className="hint mt">{t("login.consent")}</p>
        {fee > 0 && <p className="hint mb-0">{t("login.feeNote", { fee })}</p>}
        {pinEnabled && (
          <div className="pin-switch">
            <span className="small">{t("pin.haveOne")}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setStep("pin"); setError(null); }}><Icon name="lock" size={14} /> {t("pin.signInWith")}</button>
          </div>
        )}
      </form>
    );
  }
  return (
    <form onSubmit={verify} noValidate>
      <p>{t("login.codeSent")} <strong>{phone}</strong></p>
      {devCode && <div className="alert info">Development code: <strong className="mono">{devCode}</strong></div>}
      <div className="field">
        <label htmlFor="code">{t("login.code")}</label>
        <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ fontSize: 22, letterSpacing: "0.4em", textAlign: "center" }} aria-invalid={Boolean(error)} required autoFocus />
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <button className="btn btn-primary btn-block btn-lg" disabled={busy || code.length !== 6} type="submit">
        {busy ? <><span className="spinner" /> {t("login.verifying")}</> : t("login.verify")}
      </button>
      <button type="button" className="btn btn-ghost btn-block mt" onClick={() => { setStep("phone"); setCode(""); setError(null); }}>{t("login.change")}</button>
    </form>
  );
}
