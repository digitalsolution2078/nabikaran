"use client";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";
import { localizeNumber, offsetLabel } from "@/lib/i18n/format";
import { SAMPLE_CSV } from "@/lib/csv-import";
import type { ImportPreview } from "@/lib/services/bulk-import";
import type { GroupItem } from "./GroupsManager";
import type { MessageKey } from "@/lib/i18n/dict";

type Kind = GroupItem["kind"];
const DEFAULTS: Record<Kind, { category: string; offsetsDays: number[]; repeatYearly: boolean; localTime: string }> = {
  birthday: { category: "birthday", offsetsDays: [1, 0], repeatYearly: true, localTime: "08:00" },
  anniversary: { category: "anniversary", offsetsDays: [7, 1, 0], repeatYearly: true, localTime: "08:00" },
  custom: { category: "event", offsetsDays: [7, 1, 0], repeatYearly: false, localTime: "09:00" },
};
const DAY_CHOICES = [30, 15, 7, 3, 1, 0];

export function BulkImport({ groups, initialGroupId, topupMin = 20 }: { groups: GroupItem[]; initialGroupId: string | null; topupMin?: number }) {
  const { t, prefs } = usePrefs();
  const router = useRouter();
  const lang = prefs.lang;
  const n = (v: number) => localizeNumber(v, lang);
  const start = groups.find((g) => g.id === initialGroupId) ?? null;
  const [mode, setMode] = useState<"existing" | "new">(start || groups.length ? "existing" : "new");
  const [groupId, setGroupId] = useState<string>(start?.id ?? groups[0]?.id ?? "");
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<Kind>("birthday");
  const kind: Kind = mode === "existing" ? groups.find((g) => g.id === groupId)?.kind ?? "custom" : newKind;
  const [calendar, setCalendar] = useState<"AD" | "BS">(prefs.date);
  const [days, setDays] = useState<number[]>(DEFAULTS[kind].offsetsDays);
  const [repeat, setRepeat] = useState(DEFAULTS[kind].repeatYearly);
  const [localTime, setLocalTime] = useState(DEFAULTS[kind].localTime);
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const fileRef = useRef<HTMLInputElement>(null);

  const applyKind = (k: Kind) => {
    setDays(DEFAULTS[k].offsetsDays);
    setRepeat(DEFAULTS[k].repeatYearly);
    setLocalTime(DEFAULTS[k].localTime);
    setPreview(null);
  };

  const request = useMemo(() => ({
    csv,
    groupId: mode === "existing" && groupId ? groupId : null,
    newGroup: mode === "new" ? { name: newName.trim(), kind: newKind } : null,
    defaults: { calendar, category: DEFAULTS[kind].category, localTime, offsetsDays: [...days].sort((a, b) => b - a), repeatYearly: repeat },
  }), [csv, mode, groupId, newName, newKind, calendar, kind, localTime, days, repeat]);

  const ready = csv.trim().length > 0 && days.length > 0 && (mode === "existing" ? Boolean(groupId) : newName.trim().length > 0);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ preview: ImportPreview }>("/api/renewals/import/preview", { method: "POST", json: request });
      setPreview(r.preview);
      setSkip(false);
      setKey(crypto.randomUUID());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ groupId: string | null; created: number }>("/api/renewals/import", { method: "POST", json: { ...request, skipInvalid: skip, idempotencyKey: key } });
      router.push(r.groupId ? `/renewals?filter=all&group=${r.groupId}&imported=${r.created}` : `/renewals?filter=all&imported=${r.created}`);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === "insufficient_credits") await check();
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const readFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > 200_000) return setError(t("imp.tooBig"));
    const reader = new FileReader();
    reader.onload = () => { setCsv(String(reader.result ?? "")); setPreview(null); };
    reader.readAsText(f);
  };

  const downloadSample = () => {
    const blob = new Blob(["﻿" + SAMPLE_CSV], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "nabikaran-import-sample.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const shortfall = preview ? Math.max(topupMin, preview.shortfallCredits) : topupMin;

  return (
    <div className="stack">
      <section className="card">
        <h2>1. {t("imp.step.group")}</h2>
        <div className="segmented" role="group" aria-label={t("imp.step.group")} style={{ marginBottom: 12 }}>
          <button type="button" aria-pressed={mode === "existing"} disabled={!groups.length} onClick={() => { setMode("existing"); applyKind(groups.find((g) => g.id === groupId)?.kind ?? "custom"); }}>{t("imp.existingGroup")}</button>
          <button type="button" aria-pressed={mode === "new"} onClick={() => { setMode("new"); applyKind(newKind); }}>{t("grp.new")}</button>
        </div>
        {mode === "existing" ? (
          <div className="field mb-0">
            <label htmlFor="imp-group">{t("grp.group")}</label>
            <select id="imp-group" value={groupId} onChange={(e) => { setGroupId(e.target.value); applyKind(groups.find((g) => g.id === e.target.value)?.kind ?? "custom"); }}>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        ) : (
          <div className="grid grid-2">
            <div className="field mb-0">
              <label htmlFor="imp-name">{t("grp.name")}</label>
              <input id="imp-name" type="text" maxLength={40} value={newName} onChange={(e) => { setNewName(e.target.value); setPreview(null); }} placeholder={t(`grp.example.${newKind}` as MessageKey)} />
            </div>
            <div className="field mb-0">
              <label htmlFor="imp-kind">{t("grp.kind")}</label>
              <select id="imp-kind" value={newKind} onChange={(e) => { const k = e.target.value as Kind; setNewKind(k); applyKind(k); }}>
                {(["birthday", "anniversary", "custom"] as const).map((k) => <option key={k} value={k}>{t(`grp.kind.${k}`)}</option>)}
              </select>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>2. {t("imp.step.settings")}</h2>
        <div className="grid grid-2">
          <div className="field">
            <span className="label">{t("imp.dateCalendar")}</span>
            <div className="segmented" role="group" aria-label={t("imp.dateCalendar")}>
              <button type="button" aria-pressed={calendar === "BS"} onClick={() => { setCalendar("BS"); setPreview(null); }}>{t("prefs.bs")}</button>
              <button type="button" aria-pressed={calendar === "AD"} onClick={() => { setCalendar("AD"); setPreview(null); }}>{t("prefs.ad")}</button>
            </div>
            <span className="hint">{t("imp.calendarHint")}</span>
          </div>
          <div className="field">
            <label htmlFor="imp-time">{t("rem.expiryTime")}</label>
            <input id="imp-time" type="time" value={localTime} onChange={(e) => { setLocalTime(e.target.value || "08:00"); setPreview(null); }} />
          </div>
        </div>
        <div className="field">
          <span className="label">{t("rem.when")}</span>
          <div className="chips">
            {DAY_CHOICES.map((d) => (
              <button type="button" key={d} className="chip" aria-pressed={days.includes(d)} onClick={() => { setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d]); setPreview(null); }}>{offsetLabel(d * 1440, lang)}</button>
            ))}
          </div>
        </div>
        <label className="row small mb-0">
          <input type="checkbox" checked={repeat} onChange={(e) => { setRepeat(e.target.checked); setPreview(null); }} />
          <span><strong>{t("grp.repeatYearly")}</strong> · <span className="muted">{t("grp.repeatHint")}</span></span>
        </label>
      </section>

      <section className="card">
        <div className="row between">
          <h2 className="mb-0">3. {t("imp.step.file")}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={downloadSample}><Icon name="file" size={14} /> {t("imp.sample")}</button>
        </div>
        <p className="hint mt">{t("imp.formatHint")}</p>
        <pre className="sms" style={{ fontSize: 12 }}>name,date{"\n"}Ram Sharma,2052-04-15{"\n"}Sita Karki,2053-08-20</pre>
        <div className="row" style={{ margin: "12px 0" }}>
          <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={(e) => readFile(e.target.files?.[0])} />
          <button type="button" className="btn btn-secondary" onClick={() => fileRef.current?.click()}><Icon name="upload" size={16} /> {t("imp.chooseFile")}</button>
          <span className="small muted">{t("imp.orPaste")}</span>
        </div>
        <label htmlFor="imp-csv" className="sr-only">CSV</label>
        <textarea id="imp-csv" rows={8} value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} placeholder={"name,date\nRam Sharma,2052-04-15"} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }} />
        {error && <div className="alert bad mt" role="alert"><Icon name="alert" /> <span>{error}</span></div>}
        <div className="row between mt">
          <span className="small muted">{t("imp.limit")}</span>
          <button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={check}>{busy && !preview ? <span className="spinner" /> : <Icon name="receipt" size={16} />} {t("imp.check")}</button>
        </div>
      </section>

      {preview && (
        <section className="card">
          <h2>4. {t("imp.step.review")}</h2>
          {preview.tooMany && <div className="alert warn"><Icon name="alert" /> <span>{t("imp.tooMany")}</span></div>}
          <div className="grid grid-3">
            <div className="stat"><div className="label">{t("imp.validRows")}</div><div className="value">{n(preview.validRows)}</div><div className="sub">{n(preview.messages)} SMS</div></div>
            <div className="stat"><div className="label">{t("rem.total")}</div><div className="value">{n(preview.totalCredits)}</div><div className="sub">{t("common.credits")}</div></div>
            <div className="stat"><div className="label">{t("rem.available")}</div><div className="value">{n(preview.available)}</div><div className="sub">{t("common.credits")}</div></div>
          </div>
          <div className="table-wrap mt">
            <table>
              <thead><tr><th>#</th><th>{t("grp.personName")}</th><th>{t("imp.nextDate")}</th><th>SMS</th><th>{t("common.credits")}</th><th>{t("imp.status")}</th></tr></thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.line} className={r.errors.length ? "row-bad" : ""}>
                    <td className="num">{n(r.line)}</td>
                    <td>{r.label || "—"}{r.labelAdjusted && <span className="small muted"> · {t("imp.nameShortened")}</span>}</td>
                    <td className="nowrap">{r.nextDate ? `${r.nextDate} ${r.calendar}` : r.inputDate || "—"}{r.repeatYearly && r.nextDate ? " ↻" : ""}</td>
                    <td className="num">{n(r.messages)}</td>
                    <td className="num">{n(r.credits)}</td>
                    <td>
                      {r.errors.length
                        ? <span className="text-bad small">{r.errors.map((e) => t(`imp.err.${e}` as MessageKey)).join(", ")}</span>
                        : r.duplicate ? <span className="small" style={{ color: "var(--warn)" }}>{t("imp.duplicate")}</span> : <span className="small" style={{ color: "var(--ok)" }}>✓</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.find((r) => r.smsSample) && (
            <>
              <p className="small muted mt mb-0">{t("imp.sampleSms")}</p>
              <pre className="sms">{preview.rows.find((r) => r.smsSample)!.smsSample}</pre>
            </>
          )}
          {preview.invalidRows > 0 && (
            <label className="row small alert warn mt"><input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> <span>{t("imp.skipInvalid", { n: n(preview.invalidRows) })}</span></label>
          )}
          {!preview.sufficient && (
            <div className="alert warn mt"><Icon name="wallet" /> <span>{t("imp.needCredits", { need: n(preview.totalCredits), have: n(preview.available), short: n(preview.shortfallCredits) })}</span></div>
          )}
          <p className="hint">{t("imp.allOrNothing")}</p>
          <div className="row between mt">
            {!preview.sufficient ? (
              <a className="btn btn-accent" href={`/wallet?amount=${shortfall}&next=${encodeURIComponent("/renewals/import")}`}><Icon name="wallet" size={16} /> {t("topup.cta", { amount: n(shortfall) })}</a>
            ) : <span />}
            <button type="button" className="btn btn-primary btn-lg" disabled={busy || preview.validRows === 0 || !preview.sufficient || (preview.invalidRows > 0 && !skip) || preview.tooMany} onClick={commit}>
              {busy ? <span className="spinner" /> : <Icon name="check" size={18} />} {t("imp.import", { n: n(preview.validRows) })}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
