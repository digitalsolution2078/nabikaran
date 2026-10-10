"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "../api";
import type { IntegrationSettings } from "@/lib/services/settings";
import type { AdminSecret, SecretStatus } from "@/lib/services/secrets";
import type { ProviderStatus } from "@/lib/services/integrations";

interface State { settings: IntegrationSettings; secrets: Record<AdminSecret, SecretStatus>; providers: ProviderStatus[] }

const MODE_LABEL: Record<string, string> = { env: "Use server .env", aakash: "Aakash SMS (live)", mock: "Mock (testing only)", khalti: "Khalti", none: "Off", off: "Off", live: "Live", test: "Test (dev.khalti.com)", meta: "Meta Cloud API" };

/** Super admin: provider API keys and modes. Keys are write-only and stored encrypted on the server. */
export function IntegrationsAdmin({ initial, isProd, webhookUrl, khaltiReturnUrl }: { initial: State; isProd: boolean; webhookUrl: string; khaltiReturnUrl: string }) {
  const router = useRouter();
  const [st, setSt] = useState<State>(initial);
  const [s, setS] = useState<IntegrationSettings>(initial.settings);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ tone: "ok", text: await fn() });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => setSt(await api<State>("/api/admin/integrations"));
  const saveModes = (label: string) => run(async () => {
    setSt(await api<State>("/api/admin/integrations", { method: "POST", json: { value: s } }));
    return `${label} saved. It applies right away.`;
  });
  const test = (provider: "sms" | "khalti" | "whatsapp") => run(async () => {
    const r = await api<{ ok: boolean; detail: string }>("/api/admin/integrations/test", { method: "POST", json: { provider } });
    if (!r.ok) throw new Error(r.detail);
    return r.detail;
  });
  const status = (key: ProviderStatus["key"]) => st.providers.find((p) => p.key === key)!;
  const modeOptions = (opts: string[]) => opts.filter((o) => !(isProd && o === "mock"));

  const statusBadge = (k: ProviderStatus["key"]) => {
    const p = status(k);
    const off = ["off", "none"].includes(p.mode.split(" ")[0]);
    return (
      <span className={`badge ${off ? "" : p.ready ? "ok" : "warn"}`}>
        {off ? "Off" : p.ready ? `Ready · ${p.mode}` : `Missing: ${p.missing.join(", ")}`}
      </span>
    );
  };

  const select = (id: string, field: keyof IntegrationSettings, opts: string[], label: string) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={String(s[field])} onChange={(e) => setS({ ...s, [field]: e.target.value })}>
        {modeOptions(opts).map((o) => <option key={o} value={o}>{MODE_LABEL[o] ?? o}</option>)}
      </select>
    </div>
  );

  return (
    <div className="stack">
      <section className="card">
        <h2>Integrations</h2>
        <p className="small muted mb-0">
          Paste provider API keys here instead of editing the server <span className="mono">.env</span>. Keys are <strong>write-only</strong>: they are encrypted on the
          server, never shown again (only the last 4 characters), and every change is recorded in the audit log. A key saved here is used instead of the
          server value; remove it to go back to the server value. Changes apply within seconds, with no restart.
        </p>
      </section>
      {msg && <div className={`alert ${msg.tone}`} role="status">{msg.text}</div>}

      <section className="card">
        <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}><h2 style={{ margin: 0 }}>Aakash SMS</h2>{statusBadge("sms")}</div>
        <p className="small muted">Reminder SMS and sign-in codes. Get the auth token from the Aakash SMS dashboard.</p>
        <div className="grid grid-2">
          {select("int-sms", "sms_provider", ["env", "aakash", "mock"], "SMS provider")}
          <SecretField k="aakash_auth_token" label="Auth token" st={st.secrets.aakash_auth_token} onSaved={reload} setMsg={setMsg} />
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => saveModes("SMS settings")}>Save SMS settings</button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { if (window.confirm("Send one test SMS to your own number? It uses one SMS.")) test("sms"); }}>Send test SMS to me</button>
        </div>
      </section>

      <section className="card">
        <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}><h2 style={{ margin: 0 }}>Khalti</h2>{statusBadge("khalti")}</div>
        <p className="small muted">Online top-ups. Use the <strong>live secret key</strong> from the Khalti merchant dashboard (test keys work only with the test environment). Return URL: <span className="mono">{khaltiReturnUrl}</span></p>
        <div className="grid grid-2">
          {select("int-pg", "payment_gateway", ["env", "khalti", "none", "mock"], "Online payments")}
          {select("int-ke", "khalti_env", ["env", "live", "test"], "Khalti environment")}
          <SecretField k="khalti_secret_key" label="Secret key" st={st.secrets.khalti_secret_key} onSaved={reload} setMsg={setMsg} />
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => saveModes("Khalti settings")}>Save Khalti settings</button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => test("khalti")}>Check key</button>
        </div>
      </section>

      <section className="card">
        <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}><h2 style={{ margin: 0 }}>Fonepay dynamic QR</h2>{statusBadge("fonepay")}</div>
        <p className="small muted">Automatic QR top-ups (no manual verification). Credentials come from Fonepay or your acquiring bank. With &quot;Off&quot;, the static QR and admin verification keep working.</p>
        <div className="grid grid-2">
          {select("int-fp", "fonepay_mode", ["env", "off", "live", "mock"], "Mode")}
          <div className="field"><label htmlFor="int-fpm">Merchant code</label><input id="int-fpm" type="text" value={s.fonepay_merchant_code} onChange={(e) => setS({ ...s, fonepay_merchant_code: e.target.value })} placeholder="Leave empty to use the server value" /></div>
          <SecretField k="fonepay_username" label="API username" st={st.secrets.fonepay_username} onSaved={reload} setMsg={setMsg} />
          <SecretField k="fonepay_password" label="API password" st={st.secrets.fonepay_password} onSaved={reload} setMsg={setMsg} />
          <SecretField k="fonepay_secret_key" label="Secret key (HMAC)" st={st.secrets.fonepay_secret_key} onSaved={reload} setMsg={setMsg} />
        </div>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => saveModes("Fonepay settings")}>Save Fonepay settings</button>
      </section>

      <section className="card">
        <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}><h2 style={{ margin: 0 }}>WhatsApp (Meta Cloud API)</h2>{statusBadge("whatsapp")}</div>
        <p className="small muted">
          From Meta Business → WhatsApp → API setup: a permanent (system user) access token and the app secret. Choose your own verify token and enter the same one in Meta.
          Webhook URL: <span className="mono" style={{ wordBreak: "break-all" }}>{webhookUrl}</span>. Phone number ID, templates and the on/off switch are in <Link href="/admin/sms">Channels &amp; pricing</Link>.
        </p>
        <div className="grid grid-2">
          {select("int-wa", "whatsapp_provider", ["env", "off", "meta", "mock"], "Provider")}
          <SecretField k="whatsapp_access_token" label="Access token" st={st.secrets.whatsapp_access_token} onSaved={reload} setMsg={setMsg} />
          <SecretField k="whatsapp_app_secret" label="App secret" st={st.secrets.whatsapp_app_secret} onSaved={reload} setMsg={setMsg} />
          <SecretField k="whatsapp_verify_token" label="Webhook verify token" st={st.secrets.whatsapp_verify_token} onSaved={reload} setMsg={setMsg} />
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => saveModes("WhatsApp settings")}>Save WhatsApp settings</button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => test("whatsapp")}>Check connection</button>
        </div>
      </section>

      <section className="card">
        <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}><h2 style={{ margin: 0 }}>Email (Resend)</h2>{statusBadge("email")}</div>
        <p className="small muted">Email codes, email reminders and summaries. From address, on/off and a test send are in <Link href="/admin/pro">Pro &amp; email</Link>.</p>
        <div className="grid grid-2">
          <SecretField k="resend_api_key" label="Resend API key" st={st.secrets.resend_api_key} onSaved={reload} setMsg={setMsg} />
        </div>
      </section>
    </div>
  );
}

function SecretField({ k, label, st, onSaved, setMsg }: { k: AdminSecret; label: string; st: SecretStatus; onSaved: () => Promise<void>; setMsg: (m: { tone: "ok" | "bad"; text: string } | null) => void }) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (value: string | null) => {
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/admin/secrets", { method: "POST", json: { key: k, value } });
      setV("");
      await onSaved();
      setMsg({ tone: "ok", text: value ? `${label} saved (ends with …${value.slice(-4)}).` : `${label} removed from the panel.` });
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="field">
      <label htmlFor={`sec-${k}`}>{label}</label>
      <div className="small" style={{ marginBottom: 6 }}>
        {st.source === "admin" && <><span className="badge ok">Saved here · …{st.last4}</span>{" "}<button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { if (window.confirm(`Remove ${label} from the panel? The server .env value (if any) is used instead.`)) save(null); }}>Remove</button></>}
        {st.source === "env" && <span className="badge info">From server .env · …{st.last4}</span>}
        {st.source === "none" && <span className="badge warn">Not set</span>}
        {st.unreadable && <span className="badge bad">Saved key cannot be read (server key changed): paste it again</span>}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input id={`sec-${k}`} type="password" autoComplete="off" spellCheck={false} value={v} onChange={(e) => setV(e.target.value)} placeholder={st.source === "admin" ? "Paste a new value to replace" : "Paste the value"} />
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || v.trim().length < 4} onClick={() => save(v.trim())}>{st.source === "admin" ? "Replace" : "Save"}</button>
      </div>
    </div>
  );
}
