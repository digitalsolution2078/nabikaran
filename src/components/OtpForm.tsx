"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { usePrefs } from "./Prefs";

export function OtpForm({ next }: { next?: string | null }) {
  const router = useRouter();
  const { t } = usePrefs();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"phone" | "code">("phone");
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
      const r = await api<{ next: string }>("/api/auth/otp/verify", { method: "POST", json: { phone, code } });
      router.push(next ?? r.next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
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
