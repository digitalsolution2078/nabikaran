"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";

interface Settings { enabled: boolean; phone_number_id: string; business_account_id: string; template_namespace: string; default_language: string }

export function WhatsAppSettingsForm({ initial, canEdit }: { initial: Settings; canEdit: boolean }) {
  const router = useRouter();
  const [s, setS] = useState<Settings>(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function save() {
    if (s.enabled && !initial.enabled && !confirm("Enable WhatsApp reminders for customers?\n\nOnly do this after the Meta templates are APPROVED and a test message worked.")) return;
    try {
      await api("/api/admin/whatsapp", { method: "POST", json: { action: "settings", value: s } });
      setMsg({ ok: true, text: "Saved and recorded in the audit log." });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }
  const f = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: e.target.value.trim() });
  return (
    <div>
      {msg && <div className={`alert ${msg.ok ? "ok" : "bad"}`} role="status">{msg.text}</div>}
      <label className="row"><input type="checkbox" disabled={!canEdit} checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> <strong>WhatsApp reminders enabled for customers</strong></label>
      <div className="grid grid-2 mt">
        <div className="field"><label htmlFor="wa-pn">Phone number ID</label><input id="wa-pn" inputMode="numeric" disabled={!canEdit} value={s.phone_number_id} onChange={f("phone_number_id")} placeholder="e.g. 1234567890123" /></div>
        <div className="field"><label htmlFor="wa-waba">WhatsApp Business Account ID</label><input id="wa-waba" inputMode="numeric" disabled={!canEdit} value={s.business_account_id} onChange={f("business_account_id")} /></div>
        <div className="field"><label htmlFor="wa-ns">Template namespace (optional)</label><input id="wa-ns" disabled={!canEdit} value={s.template_namespace} onChange={f("template_namespace")} /></div>
        <div className="field"><label htmlFor="wa-lang">Default language</label><input id="wa-lang" disabled={!canEdit} value={s.default_language} onChange={f("default_language")} placeholder="en" /></div>
      </div>
      {canEdit ? <button className="btn btn-primary" onClick={save}>Save WhatsApp settings</button> : <p className="small muted">Only a Super Admin can change WhatsApp settings.</p>}
    </div>
  );
}

export function WaTemplateEditor({ locale, category, initial, canEdit }: { locale: "en-NP" | "ne-NP"; category: "default" | "today"; initial: { meta_name: string; meta_language: string; body_preview: string }; canEdit: boolean }) {
  const router = useRouter();
  const [t, setT] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    try {
      const r = await api<{ version: number }>("/api/admin/whatsapp", { method: "POST", json: { action: "template", locale, category, ...t } });
      setMsg(`Saved as version ${r.version}.`);
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  const sample = t.body_preview.replaceAll("{{1}}", "Bluebook").replaceAll("{{2}}", "7").replaceAll("{{3}}", "2026-11-02");
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="grid grid-2">
        <div className="field"><label>Meta template name</label><input disabled={!canEdit} value={t.meta_name} onChange={(e) => setT({ ...t, meta_name: e.target.value })} /></div>
        <div className="field"><label>Language code</label><input disabled={!canEdit} value={t.meta_language} onChange={(e) => setT({ ...t, meta_language: e.target.value })} /></div>
      </div>
      <div className="field"><label>Body as approved in Meta ({"{{1}}"} label, {"{{2}}"} days, {"{{3}}"} date)</label><textarea rows={3} disabled={!canEdit} value={t.body_preview} onChange={(e) => setT({ ...t, body_preview: e.target.value })} /></div>
      <div><span className="small muted">Customer preview:</span><pre className="sms sms-wa">{sample}</pre></div>
      {canEdit && <div className="row"><button className="btn btn-secondary btn-sm" onClick={save}>Save mapping</button>{msg && <span className="small" role="status">{msg}</span>}</div>}
    </div>
  );
}
