"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import { CATEGORIES, TEMPLATE_GROUPS } from "@/lib/categories";
import { describeOffset } from "@/lib/scheduler";
import { renderReminder } from "@/lib/sms/templates";
import { renderWhatsApp } from "@/lib/whatsapp/templates";
import { api as apiGet } from "../api";

interface T {
  slug: string; group_key: string; category: string; name_en: string; name_ne: string; sms_label: string;
  description_en: string; description_ne: string; default_offsets: number[]; popular: boolean; active: boolean; sort_order: number;
  published?: boolean; version?: number; default_channels?: string[];
}

function CustomerPreview({ t }: { t: T }) {
  const expiry = new Date(Date.now() + 40 * 86400000);
  const due = new Date(expiry.getTime() - (t.default_offsets[0] ?? 0) * 60000);
  let sms = "";
  try {
    sms = renderReminder({ label: t.sms_label || t.name_en, expiryAtUtc: expiry, dueAtUtc: due, locale: "en-NP" }).body;
  } catch (e) {
    sms = `(cannot render: ${(e as Error).message})`;
  }
  const wa = renderWhatsApp({ label: t.name_en, expiryAtUtc: expiry, dueAtUtc: due, locale: "en-NP" }).preview;
  return (
    <div className="card" style={{ margin: 0 }}>
      <strong>Preview as customer</strong>
      <div className="tpl mt" style={{ pointerEvents: "none" }}><span><span className="name">{t.name_ne || t.name_en}</span><br /><span className="desc">{t.name_en}</span></span></div>
      <p className="small muted mt">{t.description_en}</p>
      <p className="small muted">{t.description_ne}</p>
      <div className="small">Default schedule: {t.default_offsets.map(describeOffset).join(", ") || "—"}</div>
      <div className="mt"><span className="ch-badge ch-sms">SMS</span><pre className="sms">{sms}</pre></div>
      <div className="mt"><span className="ch-badge ch-wa">WhatsApp</span><pre className="sms sms-wa">{wa}</pre></div>
      {!t.published && <div className="alert warn mt">Draft — customers do not see this template until it is published.</div>}
    </div>
  );
}

function Versions({ slug }: { slug: string }) {
  const [rows, setRows] = useState<Array<{ version: number; created_at: string; changed_by_phone: string | null; snapshot: Record<string, unknown> }> | null>(null);
  async function load() {
    const r = await apiGet<{ versions: NonNullable<typeof rows> }>(`/api/admin/doc-templates?slug=${encodeURIComponent(slug)}`);
    setRows(r.versions);
  }
  return (
    <details onToggle={(e) => (e.currentTarget.open && rows === null ? void load() : undefined)}>
      <summary className="small">Version history</summary>
      {rows === null ? <p className="small muted">Loading…</p> : (
        <ul className="small">
          {rows.map((v) => <li key={v.version}>v{v.version} · {v.created_at.slice(0, 16).replace("T", " ")} UTC · {v.changed_by_phone ?? "seed"} · {String(v.snapshot.name_en)} · {v.snapshot.published === false ? "draft" : "published"} · {v.snapshot.active ? "active" : "hidden"}</li>)}
        </ul>
      )}
    </details>
  );
}

const BLANK: T = { slug: "", group_key: "custom", category: "other", name_en: "", name_ne: "", sms_label: "", description_en: "Enter the expiry date printed on your own document and confirm renewal rules with the issuing office.", description_ne: "आफ्नै कागजातमा लेखिएको म्याद राख्नुहोस् र नवीकरणका नियम सम्बन्धित कार्यालयमा पुष्टि गर्नुहोस्।", default_offsets: [10080, 1440], popular: false, active: true, sort_order: 500, published: false, default_channels: ["sms"] };

export function DocTemplateEditor({ templates, canEdit = true }: { templates: T[]; canEdit?: boolean }) {
  const router = useRouter();
  const [edit, setEdit] = useState<T | null>(null);
  const [offsetsText, setOffsetsText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const open = (t: T) => {
    setEdit({ ...t });
    setOffsetsText(t.default_offsets.map((m) => String(m / 1440)).join(", "));
    setMsg(null);
  };
  async function save() {
    if (!edit) return;
    const offsets = offsetsText.split(",").map((s) => Math.round(Number(s.trim()) * 1440)).filter((n) => Number.isFinite(n) && n >= 0);
    try {
      await api("/api/admin/doc-templates", { method: "POST", json: { ...edit, default_offsets: offsets } });
      setMsg("Saved.");
      setEdit(null);
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  const f = (k: keyof T) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setEdit((o) => (o ? { ...o, [k]: e.target.value } : o));

  return (
    <div className="stack">
      <div className="row between"><h2 className="mb-0">{templates.length} templates</h2>{canEdit && <button className="btn btn-primary btn-sm" onClick={() => open(BLANK)}>New template</button>}</div>
      {msg && <div className="alert info" role="status">{msg}</div>}
      {edit && (
        <section className="card">
          <h2>{edit.slug ? `Edit ${edit.slug}` : "New template"}</h2>
          <div className="grid grid-3">
            <div className="field"><label>Slug</label><input type="text" value={edit.slug} onChange={f("slug")} disabled={templates.some((t) => t.slug === edit.slug) && edit.slug !== ""} /></div>
            <div className="field"><label>Group</label><select value={edit.group_key} onChange={f("group_key")}>{TEMPLATE_GROUPS.map((g) => <option key={g}>{g}</option>)}</select></div>
            <div className="field"><label>Category</label><select value={edit.category} onChange={f("category")}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></div>
            <div className="field"><label>Name (English)</label><input type="text" value={edit.name_en} onChange={f("name_en")} /></div>
            <div className="field"><label>Name (नेपाली)</label><input type="text" value={edit.name_ne} onChange={f("name_ne")} /></div>
            <div className="field"><label>SMS label (English, ≤30)</label><input type="text" maxLength={30} value={edit.sms_label} onChange={f("sms_label")} /></div>
          </div>
          <div className="grid grid-2">
            <div className="field"><label>Description (English)</label><textarea rows={3} value={edit.description_en} onChange={f("description_en")} /></div>
            <div className="field"><label>Description (नेपाली)</label><textarea rows={3} value={edit.description_ne} onChange={f("description_ne")} /></div>
          </div>
          <div className="grid grid-3">
            <div className="field"><label>Default reminders (days before, comma-separated)</label><input type="text" value={offsetsText} onChange={(e) => setOffsetsText(e.target.value)} /></div>
            <div className="field"><label>Sort order</label><input type="number" value={edit.sort_order} onChange={(e) => setEdit({ ...edit, sort_order: Number(e.target.value) })} /></div>
            <div className="field"><span className="label">Flags</span>
              <label className="row small"><input type="checkbox" checked={edit.popular} onChange={(e) => setEdit({ ...edit, popular: e.target.checked })} /> Popular</label>
              <label className="row small"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>
              <label className="row small"><input type="checkbox" checked={edit.published !== false} onChange={(e) => setEdit({ ...edit, published: e.target.checked })} /> Published</label>
              <span className="label mt">Default channels</span>
              <label className="row small"><input type="checkbox" checked={(edit.default_channels ?? ["sms"]).includes("sms")} onChange={(e) => setEdit({ ...edit, default_channels: e.target.checked ? [...new Set([...(edit.default_channels ?? []), "sms"])] : (edit.default_channels ?? []).filter((c) => c !== "sms") })} /> SMS</label>
              <label className="row small"><input type="checkbox" checked={(edit.default_channels ?? []).includes("whatsapp")} onChange={(e) => setEdit({ ...edit, default_channels: e.target.checked ? [...new Set([...(edit.default_channels ?? []), "whatsapp"])] : (edit.default_channels ?? []).filter((c) => c !== "whatsapp") })} /> WhatsApp</label>
            </div>
          </div>
          <div className="grid grid-2 mt"><CustomerPreview t={{ ...edit, default_offsets: offsetsText.split(",").map((x) => Math.round(Number(x.trim()) * 1440)).filter((n) => Number.isFinite(n) && n >= 0) }} />{edit.slug && templates.some((x) => x.slug === edit.slug) ? <Versions slug={edit.slug} /> : <span />}</div>
          <div className="row mt">{canEdit && <button className="btn btn-primary" onClick={save}>Save template (new version)</button>}<button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button></div>
        </section>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Template</th><th>Group / category</th><th>SMS label</th><th className="hide-mobile">Default schedule</th><th>Flags</th><th /></tr></thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.slug}>
                <td><strong>{t.name_en}</strong><br /><span className="small muted">{t.name_ne}</span></td>
                <td className="small">{t.group_key} / {t.category}</td>
                <td className="mono small">{t.sms_label}</td>
                <td className="small hide-mobile">{t.default_offsets.map(describeOffset).join(", ")}</td>
                <td className="small">v{t.version ?? 1} · {t.published === false ? "draft" : "published"} · {t.active ? "active" : "hidden"}{t.popular ? " · popular" : ""}<br />{(t.default_channels ?? ["sms"]).join(" + ")}</td>
                <td><button className="btn btn-secondary btn-sm" onClick={() => open(t)}>{canEdit ? "Edit" : "View"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
