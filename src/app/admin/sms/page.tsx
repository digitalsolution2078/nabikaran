import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { listSmsTemplates } from "@/lib/services/admin-console";
import { listWaTemplates } from "@/lib/services/whatsapp-admin";
import { getActivePricing } from "@/lib/core/wallet";
import { getSetting } from "@/lib/services/settings";
import { getOps } from "@/lib/services/ops";
import { getDb } from "@/lib/db";
import { SmsTemplateEditor, PricingEditor } from "@/components/admin/SmsControls";
import { WhatsAppSettingsForm, WaTemplateEditor } from "@/components/admin/WhatsAppControls";
import { validateTemplateBody } from "@/lib/sms/templates";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" }) + " NPT" : "never");

/** Channels & pricing: SMS and WhatsApp prices (with history), templates, WhatsApp provider settings. */
export default async function AdminChannels() {
  const me = await getCurrentUser();
  const managePrice = can(me?.role, "sms.manage");
  const manageTemplates = can(me?.role, "templates.manage") || managePrice;
  const manageWa = can(me?.role, "whatsapp.manage");
  const [smsT, waT, smsPrice, waPrice, versions, wa, ops] = await Promise.all([
    listSmsTemplates(),
    listWaTemplates(),
    getActivePricing(undefined, "sms"),
    getActivePricing(undefined, "whatsapp"),
    getDb().query<{ id: string; channel: string; credits_per_billable_unit: number; effective_at: unknown }>("select id::text, channel, credits_per_billable_unit, effective_at from pricing_versions order by effective_at desc, id desc limit 30"),
    getSetting("whatsapp"),
    getOps(),
  ]);
  const activeSms = smsT.filter((t) => t.active);
  const activeWa = waT.filter((t) => t.active);
  const webhookUrl = `${env.appUrl}/api/webhooks/whatsapp`;
  return (
    <div className="stack">
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <h2>SMS price</h2>
          <p className="mb-0"><span style={{ fontSize: 28, fontWeight: 700 }}>{smsPrice.creditsPerUnit}</span> credits per SMS unit</p>
          <p className="hint">Provider: {env.smsProvider} · token {env.aakash.authToken ? "configured (hidden)" : "not set — add it in Admin → Integrations"}. Set the customer charge from your actual Aakash rate plus margin; reminders stay within one GSM-7 unit.</p>
          {managePrice ? <PricingEditor current={smsPrice.creditsPerUnit} channel="sms" /> : <p className="small muted">Only a Super Admin can change pricing.</p>}
        </section>
        <section className="card">
          <h2>WhatsApp price</h2>
          <p className="mb-0"><span style={{ fontSize: 28, fontWeight: 700 }}>{waPrice.creditsPerUnit}</span> credits per accepted WhatsApp template message</p>
          <p className="hint">Charged when Meta accepts the message; refunded automatically if Meta later reports it failed. Set it from your Meta rate card for utility templates in Nepal.</p>
          {managePrice ? <PricingEditor current={waPrice.creditsPerUnit} channel="whatsapp" /> : <p className="small muted">Only a Super Admin can change pricing.</p>}
        </section>
      </div>

      <section className="card">
        <h2>Price history</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Version</th><th>Channel</th><th className="num">Credits</th><th>Effective from</th></tr></thead>
            <tbody>{versions.rows.map((v) => <tr key={v.id}><td>v{v.id}</td><td>{v.channel === "whatsapp" ? "WhatsApp" : "SMS"}</td><td className="num">{v.credits_per_billable_unit}</td><td className="small">{when(new Date(String(v.effective_at instanceof Date ? v.effective_at.toISOString() : v.effective_at)).toISOString())}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="hint mt mb-0">Scheduled messages keep the price they were reserved at; a new price applies to new reminders only.</p>
      </section>

      <section className="card">
        <h2>WhatsApp (Meta Cloud API)</h2>
        <dl className="kv">
          <dt>Server provider</dt><dd>{env.whatsapp.provider}{env.whatsapp.provider === "off" ? " — set it in Admin → Integrations" : ""}</dd>
          <dt>Access token</dt><dd>{env.whatsapp.accessToken ? "configured (hidden)" : "not set (Admin → Integrations)"}</dd>
          <dt>App secret</dt><dd>{env.whatsapp.appSecret ? "configured (hidden)" : "not set (Admin → Integrations) — webhooks will be rejected"}</dd>
          <dt>Verify token</dt><dd>{env.whatsapp.verifyToken ? "configured (hidden)" : "not set (Admin → Integrations)"}</dd>
          <dt>Webhook URL</dt><dd className="mono small" style={{ wordBreak: "break-all" }}>{webhookUrl}</dd>
          <dt>Webhook verified</dt><dd>{when(ops.whatsapp.webhookVerifiedAt)}</dd>
          <dt>Last webhook received</dt><dd>{when(ops.whatsapp.lastWebhookAt)}{ops.whatsapp.lastWebhookSignatureOk === false ? " — signature FAILED" : ""}</dd>
          <dt>Last send attempt</dt><dd>{when(ops.whatsapp.lastAttemptAt)} · {ops.whatsapp.lastAttemptState ?? "—"}{ops.whatsapp.lastError ? ` · ${ops.whatsapp.lastError}` : ""}</dd>
        </dl>
        <hr className="sep" />
        <WhatsAppSettingsForm initial={wa} canEdit={manageWa} />
      </section>

      <section className="card">
        <h2>WhatsApp templates (Meta-approved)</h2>
        <p className="small muted">Create these as <strong>Utility</strong> templates in Meta Business Manager with three body variables, wait for approval, then map them here. Nabikaran never sends free text on WhatsApp.</p>
        <div className="grid grid-2">
          {(["en-NP", "ne-NP"] as const).flatMap((locale) => (["default", "today"] as const).map((category) => {
            const t = activeWa.find((x) => x.locale === locale && x.category === category);
            return (
              <div key={`${locale}-${category}`} className="card" style={{ margin: 0 }}>
                <div className="row between"><strong>{locale === "en-NP" ? "English" : "Nepali"} · {category}</strong><span className="badge info">v{t?.version ?? "-"}</span></div>
                <WaTemplateEditor locale={locale} category={category} canEdit={manageWa} initial={{ meta_name: t?.meta_name ?? "", meta_language: t?.meta_language ?? (locale === "en-NP" ? "en" : "ne"), body_preview: t?.body_preview ?? "" }} />
              </div>
            );
          }))}
        </div>
      </section>

      <section className="card">
        <h2>SMS templates</h2>
        <p className="small muted">Placeholders: <code>{"{label}"}</code> (≤30 chars), <code>{"{days}"}</code>, <code>{"{date}"}</code>. Saved only if the worst case fits one GSM-7 SMS (160 characters). “ne-NP” = Romanized Nepali.</p>
        <div className="grid grid-2">
          {(["en-NP", "ne-NP"] as const).flatMap((locale) => (["default", "today"] as const).map((category) => {
            const t = activeSms.find((x) => x.locale === locale && x.category === category);
            const v = t ? validateTemplateBody(t.body, category) : null;
            return (
              <div key={`${locale}-${category}`} className="card" style={{ margin: 0 }}>
                <div className="row between"><strong>{locale === "en-NP" ? "English" : "Romanized Nepali"} · {category}</strong><span className="badge info">v{t?.template_version ?? "-"} · {v && v.ok ? `${v.worstCaseSeptets}/160 worst case` : "invalid"}</span></div>
                {manageTemplates && managePrice ? <SmsTemplateEditor locale={locale} category={category} body={t?.body ?? ""} /> : <pre className="sms mt">{t?.body}</pre>}
              </div>
            );
          }))}
        </div>
      </section>
    </div>
  );
}
