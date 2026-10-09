"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";
import { localizeNumber } from "@/lib/i18n/format";

export interface GroupItem {
  id: string;
  name: string;
  kind: "custom" | "birthday" | "anniversary";
  active: number;
  total: number;
}

const KINDS = ["birthday", "anniversary", "custom"] as const;

export function GroupsManager({ groups }: { groups: GroupItem[] }) {
  const { t, prefs } = usePrefs();
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<GroupItem["kind"]>("birthday");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; kind: GroupItem["kind"] } | null>(null);
  const [removing, setRemoving] = useState<GroupItem | null>(null);
  const n = (v: number) => localizeNumber(v, prefs.lang);
  const kindLabel = (k: GroupItem["kind"]) => t(`grp.kind.${k}`);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api("/api/groups", { method: "POST", json: { name, kind } }))) setName("");
        }}
      >
        <h2>{t("grp.new")}</h2>
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="g-name">{t("grp.name")}</label>
            <input id="g-name" type="text" maxLength={40} required value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "birthday" ? t("grp.example.birthday") : kind === "anniversary" ? t("grp.example.anniversary") : t("grp.example.custom")} />
          </div>
          <div className="field">
            <label htmlFor="g-kind">{t("grp.kind")}</label>
            <select id="g-kind" value={kind} onChange={(e) => setKind(e.target.value as GroupItem["kind"])}>
              {KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
            </select>
          </div>
        </div>
        <p className="hint">{t(`grp.kindHint.${kind}`)}</p>
        <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}><Icon name="plus" size={16} /> {t("grp.create")}</button>
      </form>

      {error && <div className="alert bad" role="alert"><Icon name="alert" /> <span>{error}</span></div>}

      {groups.length === 0 ? (
        <div className="card empty">
          <div className="icon-wrap"><Icon name="folder" size={26} /></div>
          <p>{t("grp.empty")}</p>
        </div>
      ) : (
        <ul className="renewal-list">
          {groups.map((g) => (
            <li key={g.id}>
              <div className="renewal-row group-row">
                <span className="avatar-icon"><Icon name={g.kind === "custom" ? "folder" : "gift"} /></span>
                <span className="rr-main">
                  {editing?.id === g.id ? (
                    <span className="row" style={{ flexWrap: "wrap" }}>
                      <input aria-label={t("grp.name")} type="text" maxLength={40} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} style={{ flex: "1 1 160px" }} />
                      <select aria-label={t("grp.kind")} value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as GroupItem["kind"] })}>
                        {KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
                      </select>
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !editing.name.trim()} onClick={async () => { if (await run(() => api(`/api/groups/${g.id}`, { method: "PATCH", json: { name: editing.name, kind: editing.kind } }))) setEditing(null); }}>{t("rem.save")}</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>{t("rem.back")}</button>
                    </span>
                  ) : (
                    <>
                      <Link href={`/renewals?filter=all&group=${g.id}`} className="rr-title">{g.name}</Link>
                      <span className="rr-meta">{kindLabel(g.kind)} · {t("grp.count", { active: n(g.active), total: n(g.total) })}</span>
                    </>
                  )}
                </span>
                {editing?.id !== g.id && (
                  <span className="row group-actions">
                    <Link className="btn btn-secondary btn-sm" href={`/renewals/import?group=${g.id}`}><Icon name="upload" size={14} /> {t("imp.short")}</Link>
                    <Link className="btn btn-secondary btn-sm" href={`/renewals/new?group=${g.id}`}><Icon name="plus" size={14} /></Link>
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={t("grp.rename")} onClick={() => setEditing({ id: g.id, name: g.name, kind: g.kind })}><Icon name="edit" size={14} /></button>
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={t("grp.delete")} onClick={() => setRemoving(g)}><Icon name="x" size={14} /></button>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {removing && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="del-title" onClick={(e) => e.target === e.currentTarget && setRemoving(null)}>
          <div className="modal">
            <h2 id="del-title">{t("grp.deleteTitle", { name: removing.name })}</h2>
            <p>{t("grp.deleteBody", { n: n(removing.active) })}</p>
            <div className="stack" style={{ gap: 8 }}>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={async () => { if (await run(() => api(`/api/groups/${removing.id}`, { method: "DELETE", json: { cancelReminders: false } }))) setRemoving(null); }}>{t("grp.deleteKeep")}</button>
              {removing.active > 0 && (
                <button type="button" className="btn btn-danger" disabled={busy} onClick={async () => { if (await run(() => api(`/api/groups/${removing.id}`, { method: "DELETE", json: { cancelReminders: true } }))) setRemoving(null); }}>{t("grp.deleteCancel", { n: n(removing.active) })}</button>
              )}
              <button type="button" className="btn btn-ghost" onClick={() => setRemoving(null)}>{t("rem.back")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
