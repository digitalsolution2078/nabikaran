"use client";
import { useState } from "react";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";

interface Status { email: string | null; verified: boolean }

/** Pro: add and verify an email (for email reminders and email sign-in). */
export function EmailManager({ initial }: { initial: Status }) {
  const { t } = usePrefs();
  const [st, setSt] = useState<Status>(initial);
  const [email, setEmail] = useState(initial.verified ? "" : initial.email ?? "");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
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

  const send = () => run(async () => {
    await api("/api/me/email", { method: "POST", json: { email } });
    setSentTo(email.trim().toLowerCase());
    setMsg({ ok: true, text: t("email.codeSent", { email: email.trim() }) });
  });
  const verify = () => run(async () => {
    setSt(await api<Status>("/api/me/email", { method: "PUT", json: { email: sentTo, code } }));
    setSentTo(null); setCode(""); setEmail("");
    setMsg({ ok: true, text: t("email.saved") });
  });
  const remove = () => run(async () => {
    setSt(await api<Status>("/api/me/email", { method: "DELETE", json: {} }));
  });

  return (
    <section className="card" id="email" aria-labelledby="email-h">
      <h2 id="email-h"><Icon name="message" size={18} /> {t("email.title")} <span className="badge info">Pro</span></h2>
      <p className="muted">{t("email.intro")}</p>
      {st.verified && st.email && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <strong>{st.email}</strong> <span className="badge ok">{t("email.verified")}</span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={remove}>{t("email.remove")}</button>
        </div>
      )}
      {!sentTo ? (
        <form className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={(e) => { e.preventDefault(); send(); }}>
          <div className="field mb-0 grow" style={{ minWidth: 220 }}>
            <label htmlFor="em-addr">{t("email.address")}</label>
            <input id="em-addr" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={120} />
          </div>
          <button className="btn btn-secondary" disabled={busy || !email.includes("@")}>{busy ? <span className="spinner" /> : null} {t("email.sendCode")}</button>
        </form>
      ) : (
        <form className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={(e) => { e.preventDefault(); verify(); }}>
          <div className="field mb-0">
            <label htmlFor="em-code">{t("email.code")}</label>
            <input id="em-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ letterSpacing: "0.3em" }} />
          </div>
          <button className="btn btn-primary" disabled={busy || code.length !== 6}>{t("email.verify")}</button>
        </form>
      )}
      {msg && <div className={`alert ${msg.ok ? "ok" : "bad"} mt`} role="status">{msg.text}</div>}
    </section>
  );
}
