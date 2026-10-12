"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";

/** Super admin: reset a customer's authenticator app (lost phone and recovery codes). */
export function TwoFactorAdmin({ userId, enabled, enabledAt, canReset }: { userId: string; enabled: boolean; enabledAt: string | null; canReset: boolean }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function reset() {
    if (!window.confirm("Reset two-step sign-in? Only do this after confirming the customer's identity (e.g. a call from their registered number).")) return;
    try {
      await api(`/api/admin/users/${userId}`, { method: "POST", json: { action: "reset2fa", reason, confirm: true } });
      setMsg({ ok: true, text: "Two-step sign-in was reset. The customer can sign in with SMS / PIN and set it up again." });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }
  return (
    <div>
      <p className="mb-0">{enabled ? <><span className="badge ok">On</span> since {enabledAt?.slice(0, 10)}</> : <span className="muted">Off</span>}</p>
      {enabled && canReset && (
        <div className="row mt" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field mb-0 grow" style={{ minWidth: 200 }}><label htmlFor="tfa-reason">Reason (identity check done)</label><input id="tfa-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Lost phone, verified by call" /></div>
          <button type="button" className="btn btn-danger btn-sm" disabled={reason.trim().length < 5} onClick={reset}>Reset 2FA</button>
        </div>
      )}
      {msg && <div className={`alert ${msg.ok ? "ok" : "bad"} mt`} role="status">{msg.text}</div>}
    </div>
  );
}
