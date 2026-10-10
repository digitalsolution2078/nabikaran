"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import type { EmailSettings, ProSettings } from "@/lib/services/settings";
import type { SecretStatus } from "@/lib/services/secrets";

export function ProAdmin({ pro, email, keyStatus }: { pro: ProSettings; email: EmailSettings; keyStatus: SecretStatus }) {
  const router = useRouter();
  const [p, setP] = useState(() => Object.fromEntries(Object.entries(pro).map(([k, v]) => [k, typeof v === "number" ? String(v) : v])) as Record<keyof ProSettings, string | boolean>);
  const [e, setE] = useState<EmailSettings>(email);
  const [key, setKey] = useState("");
  const [ks, setKs] = useState<SecretStatus>(keyStatus);
  const [testTo, setTestTo] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ tone: "ok", text: await fn() });
      router.refresh();
    } catch (err) {
      setMsg({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const savePro = () => run(async () => {
    const num = (k: keyof ProSettings) => Number(p[k]);
    await api("/api/admin/settings", { method: "POST", json: { key: "pro", value: {
      enabled: p.enabled, price_npr: num("price_npr"), duration_days: num("duration_days"), trial_enabled: p.trial_enabled, trial_days: num("trial_days"),
      allowance_sms: num("allowance_sms"), allowance_whatsapp: num("allowance_whatsapp"), allowance_email: num("allowance_email"),
    } } });
    return "Pro settings saved. New prices and allowances apply to new purchases only.";
  });
  const saveEmail = () => run(async () => {
    await api("/api/admin/settings", { method: "POST", json: { key: "email", value: e } });
    return "Email settings saved.";
  });
  const saveKey = (value: string | null) => run(async () => {
    setKs(await api<SecretStatus>("/api/admin/secrets", { method: "POST", json: { key: "resend_api_key", value } }));
    setKey("");
    return value ? "Resend API key saved. It is stored on the server only and is never shown again." : "Resend API key removed.";
  });
  const test = () => run(async () => {
    const r = await api<{ id: string }>("/api/admin/email-test", { method: "POST", json: { to: testTo } });
    return `Test email accepted by Resend (id ${r.id}). Check the inbox and spam folder.`;
  });

  const numField = (k: keyof ProSettings, label: string, hint?: string) => (
    <div className="field">
      <label htmlFor={`pro-${k}`}>{label}</label>
      <input id={`pro-${k}`} type="number" min={0} value={String(p[k])} onChange={(ev) => setP({ ...p, [k]: ev.target.value })} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
  const emailReady = e.enabled && ks.set && Boolean(e.from_email);

  return (
    <>
      {msg && <div className={`alert ${msg.tone}`} role="status">{msg.text}</div>}

      <section className="card">
        <h2>Email (Resend)</h2>
        <p className="small muted">
          Email codes, email sign-in and email reminders are sent through <a href="https://resend.com" target="_blank" rel="noreferrer">Resend</a>.
          In Resend: add and verify the domain <strong>nabikaran.org</strong> (it gives SPF and DKIM records to add in Hostinger DNS), then create an API key with
          &quot;Sending access&quot; and paste it here.
        </p>
        <div className="field">
          <span className="label">API key</span>
          {ks.set ? (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className="badge ok">Saved · ends with …{ks.last4}</span>
              <span className="small muted">{ks.setAt ? `since ${ks.setAt.slice(0, 16).replace("T", " ")} UTC` : ""}</span>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { if (window.confirm("Remove the Resend API key? Email stops working until a new key is saved.")) saveKey(null); }}>Remove</button>
            </div>
          ) : <span className="badge warn">Not set</span>}
          <div className="row mt" style={{ gap: 8 }}>
            <input type="password" autoComplete="off" spellCheck={false} placeholder="re_xxxxxxxxxxxxxxxxxxxxxxxx" value={key} onChange={(ev) => setKey(ev.target.value)} aria-label="Resend API key" />
            <button type="button" className="btn btn-secondary" disabled={busy || key.trim().length < 10} onClick={() => saveKey(key.trim())}>{ks.set ? "Replace key" : "Save key"}</button>
          </div>
          <span className="hint">Write-only: the key is never sent back to the browser. Changes are recorded in the audit log (last 4 characters only).</span>
        </div>
        <div className="grid grid-2">
          <div className="field"><label htmlFor="em-from-name">From name</label><input id="em-from-name" value={e.from_name} maxLength={60} onChange={(ev) => setE({ ...e, from_name: ev.target.value })} /></div>
          <div className="field"><label htmlFor="em-from">From address</label><input id="em-from" type="email" placeholder="reminders@nabikaran.org" value={e.from_email} onChange={(ev) => setE({ ...e, from_email: ev.target.value })} /><span className="hint">Must be on the domain verified in Resend.</span></div>
          <div className="field"><label htmlFor="em-reply">Reply-to (optional)</label><input id="em-reply" type="email" placeholder="support@nabikaran.org" value={e.reply_to} onChange={(ev) => setE({ ...e, reply_to: ev.target.value })} /></div>
          <div className="field"><span className="label">Sending</span><label className="row small"><input type="checkbox" checked={e.enabled} onChange={(ev) => setE({ ...e, enabled: ev.target.checked })} /> Email on</label></div>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={saveEmail}>Save email settings</button>
        <div className="row mt" style={{ gap: 8, flexWrap: "wrap" }}>
          <input type="email" placeholder="you@example.com" value={testTo} onChange={(ev) => setTestTo(ev.target.value)} aria-label="Send a test email to" style={{ maxWidth: 280 }} />
          <button type="button" className="btn btn-secondary" disabled={busy || !emailReady || !testTo.includes("@")} onClick={test}>Send test email</button>
          {!emailReady && <span className="small muted">Save the key, a From address and turn email on first.</span>}
        </div>
      </section>

      <section className="card">
        <h2>Pro plan</h2>
        <p className="small muted">
          Paid from the wallet (1 credit = NPR 1); customers top up with the usual QR / Fonepay flow first. Purchases are final (no refunds).
          The free trial gives Pro features only; included messages start with a purchase. Basic customers see only an &quot;Upgrade to Pro&quot; card and the Pro page.
        </p>
        <div className="grid grid-2">
          <div className="field"><span className="label">Sales</span><label className="row small"><input type="checkbox" checked={Boolean(p.enabled)} onChange={(ev) => setP({ ...p, enabled: ev.target.checked })} /> <strong>Pro on sale</strong></label>{!emailReady && <span className="hint">Tip: set up email above first, so Pro customers can use email reminders and email sign-in.</span>}</div>
          <div className="field"><span className="label">Free trial</span><label className="row small"><input type="checkbox" checked={Boolean(p.trial_enabled)} onChange={(ev) => setP({ ...p, trial_enabled: ev.target.checked })} /> Offer a free trial (once per account)</label></div>
          {numField("price_npr", "Price (NPR per plan)", "Shown as is; include VAT if you charge it.")}
          {numField("duration_days", "Plan length (days)")}
          {numField("trial_days", "Trial length (days)")}
          {numField("allowance_sms", "Included SMS per plan", "Counted per SMS part (a 2-part SMS uses 2).")}
          {numField("allowance_whatsapp", "Included WhatsApp messages per plan")}
          {numField("allowance_email", "Included emails per plan")}
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={savePro}>Save Pro settings</button>
      </section>
    </>
  );
}
