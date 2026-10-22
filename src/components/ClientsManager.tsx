"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";
import { formatDate, localizeNumber } from "@/lib/i18n/format";

export interface ClientItem {
  id: string;
  name: string;
  phone: string;
  note: string | null;
  activeReminders: number;
  nextDue: string | null;
}

const local = (e164: string) => e164.replace(/^\+977/, "");

/** Business accounts: add, find, edit and archive clients. */
export function ClientsManager({ initial, businessName, family = false }: { initial: ClientItem[]; businessName: string; family?: boolean }) {
  const router = useRouter();
  const { t, prefs } = usePrefs();
  const [q, setQ] = useState("");
  const [form, setForm] = useState({ name: "", phone: "", note: "", consent: false });
  const [editing, setEditing] = useState<{ id: string; name: string; phone: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const n = (v: number) => localizeNumber(v, prefs.lang);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return initial;
    const digits = s.replace(/\D/g, "");
    return initial.filter((c) => c.name.toLowerCase().includes(s) || (digits && c.phone.includes(digits)));
  }, [q, initial]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "ok", text: ok });
      router.refresh();
      return true;
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() => api("/api/clients", { method: "POST", json: { name: form.name, phone: form.phone, note: form.note || null, consent: form.consent } }), t("clients.added"));
    if (ok) setForm({ name: "", phone: "", note: "", consent: false });
  }

  return (
    <div className="stack">
      <section className="card">
        <h2><Icon name="plus" /> {t("clients.add")}</h2>
        <form onSubmit={add}>
          <div className="grid grid-2">
            <div className="field"><label htmlFor="c-name">{t("clients.name")}</label><input id="c-name" type="text" maxLength={80} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label htmlFor="c-phone">{t("clients.phone")}</label><input id="c-phone" type="tel" inputMode="numeric" required placeholder="98XXXXXXXX" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor="c-note">{t("clients.note")}</label><input id="c-note" type="text" maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t("clients.notePh")} /></div>
          <label className="row small" style={{ alignItems: "flex-start", gap: 8, marginBottom: 12 }}>
            <input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} />
            <span>{family ? t("fam.consent") : t("clients.consent", { business: businessName })}</span>
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy || !form.consent || !form.name.trim() || !form.phone.trim()}>{t("clients.addBtn")}</button>
        </form>
      </section>

      {msg && <div className={`alert ${msg.tone}`} role="status">{msg.text}</div>}

      <section className="card">
        <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>{t("clients.list", { n: n(initial.length) })}</h2>
          <input type="search" aria-label={t("clients.search")} placeholder={t("clients.search")} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
        </div>
        {shown.length === 0 ? (
          <p className="muted mt mb-0">{initial.length === 0 ? t("clients.empty") : t("clients.noMatch")}</p>
        ) : (
          <div className="list mt">
            {shown.map((c) => editing?.id === c.id ? (
              <div className="list-item" key={c.id} style={{ flexWrap: "wrap", gap: 8 }}>
                <input type="text" aria-label={t("clients.name")} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} style={{ flex: "1 1 160px" }} />
                <input type="tel" aria-label={t("clients.phone")} value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} style={{ flex: "1 1 140px" }} />
                <input type="text" aria-label={t("clients.note")} value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} style={{ flex: "2 1 200px" }} />
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={async () => { if (await run(() => api(`/api/clients/${c.id}`, { method: "PATCH", json: { name: editing.name, phone: editing.phone, note: editing.note || null } }), t("settings.saved"))) setEditing(null); }}>{t("common.save")}</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>{t("common.cancel")}</button>
              </div>
            ) : (
              <div className="list-item" key={c.id} style={{ flexWrap: "wrap", gap: 8 }}>
                <span className="grow">
                  <span className="title" style={{ display: "block" }}>{c.name}</span>
                  <span className="meta">{local(c.phone)}{c.note ? ` · ${c.note}` : ""} · {t("clients.reminders", { n: n(c.activeReminders) })}{c.nextDue ? ` · ${t("clients.next", { date: formatDate(c.nextDue, prefs) })}` : ""}</span>
                </span>
                <Link className="btn btn-primary btn-sm" href={`/renewals/new?client=${c.id}`}><Icon name="plus" size={14} /> {t("clients.addReminder")}</Link>
                {c.activeReminders > 0 && <Link className="btn btn-secondary btn-sm" href={`/renewals?client=${c.id}`}>{t("clients.view")}</Link>}
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing({ id: c.id, name: c.name, phone: local(c.phone), note: c.note ?? "" })}>{t("clients.edit")}</button>
                {c.activeReminders === 0 && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { if (confirm(t("clients.archiveConfirm", { name: c.name }))) void run(() => api(`/api/clients/${c.id}`, { method: "DELETE" }), t("clients.archived")); }}>{t("clients.archive")}</button>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
