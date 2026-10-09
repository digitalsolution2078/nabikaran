"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";

export function OtpForm({ next }: { next?: string | null }) {
  const router = useRouter();
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
    } finally {
      setBusy(false);
    }
  }

  return step === "phone" ? (
    <form onSubmit={request} className="card">
      <label htmlFor="phone">Nepal mobile number (+977)</label>
      <input id="phone" inputMode="tel" autoComplete="tel" placeholder="98XXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} required />
      <p className="muted" style={{ fontSize: 13 }}>We send a one-time code by SMS. Standard SMS consent: by continuing you agree to receive reminder SMS you schedule.</p>
      {error && <div className="error">{error}</div>}
      <button disabled={busy} type="submit">{busy ? "Sending…" : "Send code"}</button>
    </form>
  ) : (
    <form onSubmit={verify} className="card">
      <p>Code sent to <strong>{phone}</strong>. {devCode && <span className="notice">Dev code: {devCode}</span>}</p>
      <label htmlFor="code">6-digit code</label>
      <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required />
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button disabled={busy} type="submit">{busy ? "Verifying…" : "Verify"}</button>
        <button type="button" className="secondary" onClick={() => { setStep("phone"); setCode(""); }}>Change number</button>
      </div>
    </form>
  );
}
