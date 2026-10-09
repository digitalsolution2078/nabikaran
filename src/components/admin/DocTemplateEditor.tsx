"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import { CATEGORIES, TEMPLATE_GROUPS } from "@/lib/categories";
import { describeOffset } from "@/lib/scheduler";

interface T {
  slug: string; group_key: string; category: string; name_en: string; name_ne: string; sms_label: string;
  description_en: string; description_ne: string; default_offsets: number[]; popular: boolean; active: boolean; sort_order: number;
}

const BLANK: T = { slug: "", group_key: "custom", category: "other", name_en: "", name_ne: "", sms_label: "", description_en: "", description_ne: "", default_offsets: [10080, 1440], popular: false, active: true, sort_order: 500 };

export function DocTemplateEditor({ templates }: { templates: T[] }) {
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
      <div className="row between"><h2 className="mb-0">{templates.length} templates</h2><button className="btn btn-primary btn-sm" onClick={() => open(BLANK)}>New template</button></div>
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
            </div>
          </div>
          <div className="row"><button className="btn btn-primary" onClick={save}>Save template</button><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button></div>
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
                <td className="small">{t.active ? "active" : "hidden"}{t.popular ? " · popular" : ""}</td>
                <td><button className="btn btn-secondary btn-sm" onClick={() => open(t)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
