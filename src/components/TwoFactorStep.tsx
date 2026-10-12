"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

/** Second sign-in step: 6-digit code from the authenticator app, or a recovery code. */
export function TwoFactorStep({ next }: { next?: string | null }) {
  const router = useRouter();
  const { t } = usePrefs();
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ next: string }>("/api/auth/2fa", { method: "POST", json: { code } });
      router.push(next ?? r.next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setCode("");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <p className="row" style={{ gap: 8 }}><Icon name="lock" size={18} /> <strong>{t("tfa.stepTitle")}</strong></p>
      <p className="muted small">{recovery ? t("tfa.recoveryHint") : t("tfa.stepHint")}</p>
      <div className="field">
        <label htmlFor="tfa-code">{recovery ? t("tfa.recoveryCode") : t("tfa.appCode")}</label>
        {recovery ? (
          <input id="tfa-code" autoComplete="one-time-code" autoCapitalize="characters" maxLength={20} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="mono" style={{ fontSize: 20, textAlign: "center" }} />
        ) : (
          <input id="tfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ fontSize: 24, letterSpacing: "0.4em", textAlign: "center" }} autoFocus />
        )}
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <button className="btn btn-primary btn-block btn-lg" disabled={busy || (recovery ? code.replace(/[^A-Z0-9]/g, "").length < 10 : code.length !== 6)} type="submit">
        {busy ? <span className="spinner" /> : t("tfa.verify")}
      </button>
      <button type="button" className="btn btn-ghost btn-sm mt" onClick={() => { setRecovery(!recovery); setCode(""); setError(null); }}>
        {recovery ? t("tfa.useApp") : t("tfa.useRecovery")}
      </button>
    </form>
  );
}
