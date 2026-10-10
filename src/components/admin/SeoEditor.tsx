"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import type { ManagedSeoPage } from "@/lib/services/seo";

interface Draft {
  slug: string; template: string; title: string; description: string; h1: string; intro: string; nepali: string;
  remindWhat: string; schedule: string; faqs: string; published: boolean; sortOrder: number; isNew: boolean;
}

const toDraft = (p: ManagedSeoPage): Draft => ({
  slug: p.slug, template: p.template ?? "", title: p.title, description: p.description, h1: p.h1, intro: p.intro, nepali: p.nepali,
  remindWhat: p.remindWhat.join("\n"), schedule: p.schedule, faqs: p.faqs.map((f) => `${f.q} | ${f.a}`).join("\n"),
  published: p.published, sortOrder: p.sortOrder, isNew: false,
});
const blank = (): Draft => ({ slug: "", template: "", title: "", description: "", h1: "", intro: "", nepali: "", remindWhat: "", schedule: "", faqs: "", published: false, sortOrder: 500, isNew: true });

export function SeoEditor({ pages, templates, canEdit }: { pages: ManagedSeoPage[]; templates: Array<{ slug: string; name_en: string }>; canEdit: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  async function save() {
    if (!draft) return;
    setBusy(true);
    setMsg(null);
    try {
      const faqs = draft.faqs.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.indexOf("|");
        return i < 0 ? { q: l, a: "" } : { q: l.slice(0, i).trim(), a: l.slice(i + 1).trim() };
      });
      await api("/api/admin/seo", {
        method: "POST",
        json: {
          slug: draft.slug.trim(), template: draft.template || null, title: draft.title, description: draft.description, h1: draft.h1, intro: draft.intro,
          nepali: draft.nepali, remindWhat: draft.remindWhat.split("\n").map((x) => x.trim()).filter(Boolean), schedule: draft.schedule, faqs,
          published: draft.published, sortOrder: Number(draft.sortOrder) || 0,
        },
      });
      setMsg({ ok: true, text: `Saved /renewal-reminder/${draft.slug}` });
      setDraft(null);
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function reset(p: ManagedSeoPage) {
    if (!confirm(p.source === "custom" ? `Delete the page "${p.slug}"?` : `Reset "${p.slug}" to the built-in version?`)) return;
    setBusy(true);
    try {
      await api("/api/admin/seo", { method: "DELETE", json: { slug: p.slug } });
      setMsg({ ok: true, text: p.source === "custom" ? "Page deleted" : "Reset to built-in version" });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const len = (s: string, max: number) => <span className={`small ${s.length > max ? "text-bad" : "muted"}`}>{s.length}/{max}</span>;

  return (
    <div className="stack">
      {msg && <div className={`alert ${msg.ok ? "ok" : "bad"}`} role="status"><span>{msg.text}</span></div>}
      <div className="row between">
        <h2 className="mb-0">SEO landing pages</h2>
        {canEdit && <button type="button" className="btn btn-primary" onClick={() => setDraft(blank())}>New page</button>}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Page</th><th>Source</th><th>Status</th><th className="num">Order</th><th /></tr></thead>
          <tbody>
            {pages.map((p) => (
              <tr key={p.slug}>
                <td><strong>{p.h1}</strong><br /><a className="small" href={`/renewal-reminder/${p.slug}`} target="_blank" rel="noreferrer">/renewal-reminder/{p.slug}</a></td>
                <td><span className={`badge ${p.source === "built-in" ? "" : "info"}`}>{p.source}</span></td>
                <td>{p.published ? <span className="badge ok">published</span> : <span className="badge">hidden</span>}</td>
                <td className="num">{p.sortOrder}</td>
                <td className="nowrap">
                  {canEdit && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDraft(toDraft(p))}>Edit</button>}{" "}
                  {canEdit && p.source !== "built-in" && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => reset(p)}>{p.source === "custom" ? "Delete" : "Reset"}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {draft && (
        <section className="card" aria-label="Edit SEO page">
          <h2>{draft.isNew ? "New page" : `Edit /renewal-reminder/${draft.slug}`}</h2>
          <p className="hint">Write for real searches (e.g. &quot;bluebook renewal reminder&quot;). Never state official validity periods, fees or deadlines as fact, and never promise delivery or renewals: the save is refused if you do.</p>
          <div className="grid grid-2">
            <div className="field"><label htmlFor="s-slug">URL slug</label><input id="s-slug" value={draft.slug} readOnly={!draft.isNew} onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="wedding-anniversary-reminder-nepal" /></div>
            <div className="field"><label htmlFor="s-tpl">“Set up” button opens template</label>
              <select id="s-tpl" value={draft.template} onChange={(e) => set("template", e.target.value)}>
                <option value="">(none: blank form)</option>
                {templates.map((t) => <option key={t.slug} value={t.slug}>{t.name_en}</option>)}
              </select>
            </div>
          </div>
          <div className="field"><label htmlFor="s-title">Browser / Google title {len(draft.title, 120)}</label><input id="s-title" value={draft.title} onChange={(e) => set("title", e.target.value)} /><span className="hint">Aim for 50–65 characters.</span></div>
          <div className="field"><label htmlFor="s-desc">Google description {len(draft.description, 300)}</label><textarea id="s-desc" rows={2} value={draft.description} onChange={(e) => set("description", e.target.value)} /><span className="hint">Aim for 120–160 characters.</span></div>
          <div className="field"><label htmlFor="s-h1">Page heading (H1)</label><input id="s-h1" value={draft.h1} onChange={(e) => set("h1", e.target.value)} /></div>
          <div className="field"><label htmlFor="s-intro">Introduction {len(draft.intro, 1200)}</label><textarea id="s-intro" rows={4} value={draft.intro} onChange={(e) => set("intro", e.target.value)} /></div>
          <div className="field"><label htmlFor="s-ne">Nepali paragraph</label><textarea id="s-ne" rows={3} lang="ne" value={draft.nepali} onChange={(e) => set("nepali", e.target.value)} /></div>
          <div className="grid grid-2">
            <div className="field"><label htmlFor="s-what">“What you can be reminded about” (one per line)</label><textarea id="s-what" rows={5} value={draft.remindWhat} onChange={(e) => set("remindWhat", e.target.value)} /></div>
            <div className="field"><label htmlFor="s-sched">Suggested schedule</label><textarea id="s-sched" rows={5} value={draft.schedule} onChange={(e) => set("schedule", e.target.value)} /></div>
          </div>
          <div className="field"><label htmlFor="s-faq">FAQs: one per line, “Question | Answer”</label><textarea id="s-faq" rows={6} value={draft.faqs} onChange={(e) => set("faqs", e.target.value)} placeholder="Does Nabikaran renew my document? | No. Nabikaran only sends reminders." /><span className="hint">These also become FAQ rich results in Google.</span></div>
          <div className="row">
            <label className="row small"><input type="checkbox" checked={draft.published} onChange={(e) => set("published", e.target.checked)} /> Published (visible and in the sitemap)</label>
            <label className="row small">Order <input type="number" style={{ width: 90 }} value={draft.sortOrder} onChange={(e) => set("sortOrder", Number(e.target.value))} /></label>
          </div>
          <div className="row between mt">
            <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy || !draft.slug} onClick={save}>Save page</button>
          </div>
        </section>
      )}
    </div>
  );
}
