import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { listSmsLog, listSmsTemplates } from "@/lib/services/admin-console";
import { getActivePricing } from "@/lib/core/wallet";
import { getDb } from "@/lib/db";
import { StatusBadge } from "@/components/StatusBadge";
import { SmsTemplateEditor, PricingEditor } from "@/components/admin/SmsControls";
import { validateTemplateBody } from "@/lib/sms/templates";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

const FILTERS = ["all", "submitted", "delivered", "failed", "unknown"] as const;

export default async function AdminSms({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status: raw } = await searchParams;
  const status = (FILTERS as readonly string[]).includes(raw ?? "") ? raw! : "all";
  const me = await getCurrentUser();
  const manage = can(me?.role, "sms.manage");
  const [log, templates, pricing, versions] = await Promise.all([
    listSmsLog(status === "all" ? null : status, 200),
    listSmsTemplates(),
    getActivePricing(),
    getDb().query<{ id: string; credits_per_billable_unit: number; effective_at: string }>("select id::text, credits_per_billable_unit, effective_at from pricing_versions order by effective_at desc, id desc limit 10"),
  ]);
  const active = templates.filter((t) => t.active);
  return (
    <div className="stack">
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <h2>Customer price per SMS</h2>
          <p className="mb-0"><span style={{ fontSize: 28, fontWeight: 700 }}>{pricing.creditsPerUnit}</span> credits per billable SMS unit <span className="muted small">(1 credit = NPR 1 of wallet value)</span></p>
          <p className="hint">Provider cost is separate (e.g. Aakash list price per SMS plus tax). Set the customer charge from your actual provider quote and margin; reminders are kept to one GSM-7 unit.</p>
          {manage ? <PricingEditor current={pricing.creditsPerUnit} /> : <p className="small muted">Only a Super Admin can change pricing.</p>}
          <details className="mt"><summary className="small">Price history</summary>
            <ul className="small">{versions.rows.map((v) => <li key={v.id}>v{v.id}: {v.credits_per_billable_unit} credits from {new Date(v.effective_at).toISOString().slice(0, 16).replace("T", " ")} UTC</li>)}</ul>
          </details>
        </section>
        <section className="card">
          <h2>Provider</h2>
          <dl className="kv">
            <dt>Adapter</dt><dd>{env.smsProvider}</dd>
            <dt>Token</dt><dd>{env.aakash.authToken ? "configured (hidden)" : "not set"}</dd>
            <dt>Send URL</dt><dd className="small mono" style={{ wordBreak: "break-all" }}>{env.aakash.sendUrl}</dd>
            <dt>Encoding policy</dt><dd>GSM-7, 1 segment (≤160 chars), English / Romanized Nepali</dd>
          </dl>
          <p className="hint mt mb-0">Change provider and credentials in <code>.env.production</code> on the server and restart the app container.</p>
        </section>
      </div>

      <section className="card">
        <h2>SMS templates</h2>
        <p className="small muted">Placeholders: <code>{"{label}"}</code> (≤30 chars), <code>{"{days}"}</code>, <code>{"{date}"}</code>. Saved only if the worst case fits one GSM-7 SMS (160 characters) with no Devanagari, emoji or double-width characters. “ne-NP” = Romanized Nepali.</p>
        <div className="grid grid-2">
          {(["en-NP", "ne-NP"] as const).flatMap((locale) => (["default", "today"] as const).map((category) => {
            const t = active.find((x) => x.locale === locale && x.category === category);
            const v = t ? validateTemplateBody(t.body, category) : null;
            return (
              <div key={`${locale}-${category}`} className="card" style={{ margin: 0 }}>
                <div className="row between"><strong>{locale === "en-NP" ? "English" : "Romanized Nepali"} · {category}</strong><span className="badge info">v{t?.template_version ?? "-"} · {v && v.ok ? `${v.worstCaseSeptets}/160 worst case` : "invalid"}</span></div>
                {manage ? <SmsTemplateEditor locale={locale} category={category} body={t?.body ?? ""} /> : <pre className="sms mt">{t?.body}</pre>}
              </div>
            );
          }))}
        </div>
      </section>

      <section>
        <div className="row between"><h2 className="mb-0">Sending log</h2>
          <nav className="admin-tabs" style={{ margin: 0 }}>{FILTERS.map((f) => <Link key={f} href={`/admin/sms?status=${f}`} className={f === status ? "active" : ""}>{f}</Link>)}</nav>
        </div>
        <div className="table-wrap mt">
          <table>
            <thead><tr><th>Sent</th><th>To</th><th>Reminder</th><th>Job</th><th className="hide-mobile">Provider</th><th className="hide-mobile">Units / report</th></tr></thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.attempt_id}>
                  <td className="nowrap small">{l.request_at.replace("T", " ").slice(0, 16)}</td>
                  <td className="small">{l.phone_e164.slice(0, 8)}****{l.phone_e164.slice(-2)}</td>
                  <td>{l.label}</td>
                  <td><StatusBadge status={l.status} />{l.error_text ? <div className="small muted">{l.error_text}</div> : null}</td>
                  <td className="small hide-mobile">{l.provider} · {l.api_state}{l.provider_message_id ? <><br /><span className="mono">{l.provider_message_id}</span></> : null}</td>
                  <td className="small hide-mobile">{l.reported_units ?? "—"} · {l.reported_status ?? "—"}</td>
                </tr>
              ))}
              {log.length === 0 && <tr><td colSpan={6} className="muted">No SMS attempts yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
