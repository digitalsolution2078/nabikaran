"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { usePrefs } from "./Prefs";

/** Pro: sign in with an emailed code. Collapsed by default under the phone sign-in. */
export function EmailLogin({ next }: { next?: string | null }) {
  const { t } = usePrefs();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ devCode?: string }>("/api/auth/email", { method: "POST", json: { email } });
      setDevCode(r.devCode ?? null);
      setSent(true);
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
      await api("/api/auth/email", { method: "PUT", json: { email, code } });
      router.push(next ?? "/dashboard");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <details className="email-login">
      <summary>{t("login.email")}</summary>
      <p className="hint">{t("login.emailHint")}</p>
      {!sent ? (
        <form onSubmit={send}>
          <div className="field">
            <label htmlFor="login-email">{t("email.address")}</label>
            <input id="login-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={120} />
          </div>
          {error && <p className="field-error" role="alert">{error}</p>}
          <button className="btn btn-secondary btn-block" disabled={busy || !email.includes("@")}>{busy ? <span className="spinner" /> : null} {t("login.emailSend")}</button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <p className="small">{t("login.emailSent")}</p>
          {devCode && <div className="alert info">Development code: <strong className="mono">{devCode}</strong></div>}
          <div className="field">
            <label htmlFor="login-email-code">{t("login.emailCode")}</label>
            <input id="login-email-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ letterSpacing: "0.3em" }} />
          </div>
          {error && <p className="field-error" role="alert">{error}</p>}
          <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>{t("login.emailSignIn")}</button>
        </form>
      )}
    </details>
  );
}
