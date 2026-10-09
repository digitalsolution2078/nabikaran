"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "./api";
import { usePrefs } from "./Prefs";
import { Icon, iconForGroup } from "./Icon";
import { ChannelBadge } from "./ChannelBadge";
import { PRESET_OFFSET_DAYS, offsetFromParts } from "@/lib/scheduler";
import type { SchedulePreview } from "@/lib/core/dto";
import type { MessageKey } from "@/lib/i18n/dict";
import { BS_MAX_YEAR, BS_MIN_YEAR, BS_MONTHS_EN, BS_MONTHS_NE, adToBs, bsDaysInMonth, bsToAd } from "@/lib/bs-date";
import { formatDate, localizeNumber, offsetLabel } from "@/lib/i18n/format";
import { kathmanduToUtc } from "@/lib/time";
import { isSmsSafeLabel } from "@/lib/sms/templates";

export interface TemplateOption {
  slug: string;
  group_key: string;
  category: string;
  name_en: string;
  name_ne: string;
  sms_label: string;
  description_en: string;
  description_ne: string;
  default_offsets: number[];
  popular: boolean;
}

export interface RenewalFormValues {
  category: string;
  label: string;
  calendar: "AD" | "BS";
  expiryDate: string;
  localTime: string;
  notes: string;
  familyMemberLabel: string;
  offsets: number[];
  templateSlug: string | null;
  channels: Array<"sms" | "whatsapp">;
  whatsappConsent?: boolean;
}

const GROUP_LABEL: Record<string, { en: string; ne: string }> = {
  vehicle: { en: "Vehicle & transport", ne: "सवारी र यातायात" },
  personal: { en: "Personal documents", ne: "व्यक्तिगत कागजात" },
  insurance: { en: "Insurance & finance", ne: "बीमा र वित्त" },
  business: { en: "Business & professional", ne: "व्यवसाय" },
  custom: { en: "Custom", ne: "आफ्नै" },
};

type Step = 0 | 1 | 2 | 3;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

const DRAFT_KEY = "nabikaran.reminderDraft";

interface Shortfall {
  needed: number;
  available: number;
  shortfall: number;
  locked?: boolean;
}

export function RenewalForm({ templates, initial, renewalId, initialTemplate, topupMin = 20, whatsapp = { available: false, optedIn: false } }: { templates: TemplateOption[]; initial?: Partial<RenewalFormValues>; renewalId?: string; initialTemplate?: string | null; topupMin?: number; whatsapp?: { available: boolean; optedIn: boolean } }) {
  const router = useRouter();
  const { t, prefs } = usePrefs();
  const lang = prefs.lang;
  const preselected = templates.find((x) => x.slug === initialTemplate) ?? null;
  const [step, setStep] = useState<Step>(renewalId || preselected ? 1 : 0);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [v, setV] = useState<RenewalFormValues>({
    category: preselected?.category ?? "other",
    label: preselected?.sms_label ?? "",
    calendar: prefs.date,
    expiryDate: "",
    localTime: "09:00",
    notes: "",
    familyMemberLabel: "",
    offsets: preselected?.default_offsets ?? [30 * 1440, 7 * 1440, 1440, 0],
    templateSlug: preselected?.slug ?? null,
    channels: ["sms"],
    ...initial,
  });
  const [custom, setCustom] = useState({ days: 0, hours: 0, minutes: 0 });
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topup, setTopup] = useState<Shortfall | null>(null);
  const [bsConfirmed, setBsConfirmed] = useState(false);

  // Restore a draft saved when the customer left to top up (new reminders only).
  useEffect(() => {
    if (renewalId) return;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      sessionStorage.removeItem(DRAFT_KEY);
      const d = JSON.parse(raw) as { v: RenewalFormValues; at: number };
      if (Date.now() - d.at < 60 * 60_000 && d.v?.label) {
        setV(d.v);
        setStep(2);
      }
    } catch {
      /* storage unavailable: start fresh */
    }
  }, [renewalId]);

  const saveDraftAndTopUp = (amount: number) => {
    try {
      if (!renewalId) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ v, at: Date.now() }));
    } catch {
      /* ignore */
    }
    router.push(`/wallet?amount=${amount}&next=${encodeURIComponent(renewalId ? `/renewals/${renewalId}/edit` : "/renewals/new")}`);
  };

  const set = <K extends keyof RenewalFormValues>(k: K, val: RenewalFormValues[K]) => {
    setV((old) => ({ ...old, [k]: val }));
    setPreview(null);
  };
  const toggle = (m: number) => set("offsets", v.offsets.includes(m) ? v.offsets.filter((x) => x !== m) : [...v.offsets, m]);

  const chooseTemplate = (tpl: TemplateOption) => {
    setV((old) => ({ ...old, category: tpl.category, label: old.label && renewalId ? old.label : tpl.sms_label, offsets: tpl.default_offsets, templateSlug: tpl.slug }));
    setPreview(null);
    setStep(1);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((x) => (!group || x.group_key === group) && (!q || `${x.name_en} ${x.name_ne} ${x.description_en}`.toLowerCase().includes(q)));
  }, [templates, query, group]);
  const popular = templates.filter((x) => x.popular);
  const chosenTpl = templates.find((x) => x.slug === v.templateSlug) ?? null;

  // Live conversion between calendars for the date the user typed.
  const conversion = useMemo(() => {
    try {
      if (!v.expiryDate) return null;
      const [y, m, d] = v.expiryDate.split("-").map(Number);
      if (!y || !m || !d) return null;
      const ad = v.calendar === "BS" ? bsToAd({ year: y, month: m, day: d }) : { year: y, month: m, day: d };
      const utc = kathmanduToUtc(ad, v.localTime);
      return { utc, other: formatDate(utc, { lang, date: v.calendar === "BS" ? "AD" : "BS" }), same: formatDate(utc, { lang, date: v.calendar }) };
    } catch {
      return null;
    }
  }, [v.expiryDate, v.calendar, v.localTime, lang]);

  const switchCalendar = (cal: "AD" | "BS") => {
    if (cal === v.calendar) return;
    let next = "";
    try {
      if (v.expiryDate) {
        const [y, m, d] = v.expiryDate.split("-").map(Number);
        const r = cal === "BS" ? adToBs({ year: y, month: m, day: d }) : bsToAd({ year: y, month: m, day: d });
        next = `${r.year}-${pad(r.month)}-${pad(r.day)}`;
      }
    } catch {
      next = "";
    }
    setV((old) => ({ ...old, calendar: cal, expiryDate: next }));
    setPreview(null);
  };

  async function loadPreview() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ preview: SchedulePreview }>("/api/renewals/preview", {
        method: "POST",
        json: { label: v.label, category: v.category, calendar: v.calendar, expiryDate: v.expiryDate, localTime: v.localTime, offsets: v.offsets, channels: v.channels, renewalId: renewalId ?? null },
      });
      setPreview(r.preview);
      setBsConfirmed(false);
      if (!r.preview.sufficient) {
        setTopup({ needed: r.preview.reservedOnConfirmCredits, available: r.preview.wallet.available, shortfall: r.preview.shortfallCredits });
      }
      setIdempotencyKey(crypto.randomUUID());
      setStep(3);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const body = { ...v, notes: v.notes || null, familyMemberLabel: v.familyMemberLabel || null, idempotencyKey };
      const r = renewalId
        ? await api<{ reminder: { id: string } }>(`/api/renewals/${renewalId}`, { method: "PATCH", json: body })
        : await api<{ reminder: { id: string } }>("/api/renewals", { method: "POST", json: body });
      router.push(`/renewals/${r.reminder.id}`);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && (e.code === "insufficient_credits" || e.code === "account_locked")) {
        const d = e.detail ?? {};
        setTopup({
          needed: d.neededCredits ?? preview?.reservedOnConfirmCredits ?? 0,
          available: d.availableCredits ?? preview?.wallet.available ?? 0,
          shortfall: d.shortfallCredits ?? Math.max(1, -(preview?.wallet.available ?? 0)),
          locked: e.code === "account_locked",
        });
      } else {
        setError((e as Error).message);
      }
      setBusy(false);
    }
  }

  const steps: MessageKey[] = ["rem.step.template", "rem.step.details", "rem.step.schedule", "rem.step.review"];
  const detailsValid = v.label.trim().length > 0 && Boolean(conversion) && conversion!.utc.getTime() > Date.now();

  return (
    <div>
      <ol className="stepper" aria-label="Progress">
        {steps.map((k, i) => (
          <li key={k} className={i < step ? "done" : i === step ? "current" : ""} aria-current={i === step ? "step" : undefined}>{t(k)}</li>
        ))}
      </ol>

      {step === 0 && (
        <section className="card">
          <div className="field">
            <label htmlFor="tpl-search" className="sr-only">{t("rem.searchTemplates")}</label>
            <div className="input-affix"><span><Icon name="search" size={16} /></span><input id="tpl-search" type="search" placeholder={t("rem.searchTemplates")} value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          </div>
          <div className="chips" style={{ marginBottom: 14 }}>
            <button type="button" className="chip" aria-pressed={group === null} onClick={() => setGroup(null)}>{t("rem.allTemplates")}</button>
            {Object.keys(GROUP_LABEL).map((g) => (
              <button type="button" key={g} className="chip" aria-pressed={group === g} onClick={() => setGroup(g)}><Icon name={iconForGroup(g)} size={14} /> {GROUP_LABEL[g][lang]}</button>
            ))}
          </div>
          {!query && !group && popular.length > 0 && (
            <>
              <h3>{t("rem.popular")}</h3>
              <div className="tpl-grid" style={{ marginBottom: 18 }}>
                {popular.map((tpl) => <TemplateCard key={tpl.slug} tpl={tpl} lang={lang} onPick={chooseTemplate} />)}
              </div>
              <h3>{t("rem.allTemplates")}</h3>
            </>
          )}
          <div className="tpl-grid">
            {filtered.map((tpl) => <TemplateCard key={tpl.slug} tpl={tpl} lang={lang} onPick={chooseTemplate} />)}
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="card">
          {chosenTpl && (
            <div className="alert info">
              <Icon name={iconForGroup(chosenTpl.group_key)} />
              <span><strong>{lang === "ne" ? chosenTpl.name_ne : chosenTpl.name_en}</strong><br /><span className="small">{lang === "ne" ? chosenTpl.description_ne : chosenTpl.description_en}</span>
                {!renewalId && <> · <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep(0)}>{t("rem.step.template")} ↺</button></>}
              </span>
            </div>
          )}
          <div className="field">
            <label htmlFor="label">{t("rem.label")}</label>
            <input id="label" type="text" value={v.label} maxLength={80} onChange={(e) => set("label", e.target.value)} placeholder="Ba 2 Pa 1234 Bluebook" required />
            <span className="hint">{t("rem.labelHint")}</span>
            {v.label && !isSmsSafeLabel(v.label) && <span className="hint" style={{ color: "var(--warn)" }}>{t("warn.sms_label_adjusted")}</span>}
          </div>
          <div className="field">
            <span className="label">{t("rem.calendar")}</span>
            <div className="segmented" role="group" aria-label={t("rem.calendar")}>
              <button type="button" aria-pressed={v.calendar === "BS"} onClick={() => switchCalendar("BS")}>{t("prefs.bs")}</button>
              <button type="button" aria-pressed={v.calendar === "AD"} onClick={() => switchCalendar("AD")}>{t("prefs.ad")}</button>
            </div>
          </div>
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="expiry">{t("rem.expiryDate")}</label>
              {v.calendar === "AD" ? (
                <input id="expiry" type="date" value={v.expiryDate} onChange={(e) => set("expiryDate", e.target.value)} required />
              ) : (
                <BsDateInput value={v.expiryDate} onChange={(s) => set("expiryDate", s)} lang={lang} />
              )}
              {conversion && <span className="hint"><Icon name="calendar" size={12} /> {t("rem.convertedDate")}: <strong>{conversion.other}</strong></span>}
              {conversion && conversion.utc.getTime() <= Date.now() && <span className="field-error" role="alert">{t("warn.expiry_in_past")}</span>}
            </div>
            <div className="field">
              <label htmlFor="time">{t("rem.expiryTime")}</label>
              <input id="time" type="time" value={v.localTime} onChange={(e) => set("localTime", e.target.value || "09:00")} />
              <span className="hint">{t("rem.timeHint")}</span>
            </div>
          </div>
          <details>
            <summary className="small" style={{ cursor: "pointer", marginBottom: 10 }}>{t("rem.family")} · {t("rem.notes")}</summary>
            <div className="grid grid-2">
              <div className="field">
                <label htmlFor="family">{t("rem.family")}</label>
                <input id="family" type="text" maxLength={60} value={v.familyMemberLabel} onChange={(e) => set("familyMemberLabel", e.target.value)} />
                <span className="hint">{t("rem.familyHint")}</span>
              </div>
              <div className="field">
                <label htmlFor="notes">{t("rem.notes")}</label>
                <textarea id="notes" rows={2} maxLength={500} value={v.notes} onChange={(e) => set("notes", e.target.value)} />
              </div>
            </div>
          </details>
          <div className="row between mt">
            {!renewalId ? <button type="button" className="btn btn-secondary" onClick={() => setStep(0)}>{t("rem.back")}</button> : <span />}
            <button type="button" className="btn btn-primary" disabled={!detailsValid} onClick={() => setStep(2)}>{t("rem.next")} <Icon name="arrowRight" size={16} /></button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="card">
          <h2>{t("rem.when")}</h2>
          <div className="chips">
            {PRESET_OFFSET_DAYS.map((d) => {
              const m = d * 1440;
              return <button type="button" key={d} className="chip" aria-pressed={v.offsets.includes(m)} onClick={() => toggle(m)}>{offsetLabel(m, lang)}</button>;
            })}
            {v.offsets.filter((m) => !PRESET_OFFSET_DAYS.map((d) => d * 1440).includes(m)).map((m) => (
              <button type="button" key={m} className="chip" aria-pressed onClick={() => toggle(m)}>{offsetLabel(m, lang)} ✕</button>
            ))}
          </div>
          <fieldset className="custom-offset mt">
            <legend className="label">{t("rem.customTitle")}</legend>
            <div className="custom-offset-grid">
              <div className="field"><label htmlFor="co-d">{t("rem.days")}</label><input id="co-d" type="number" inputMode="numeric" min={0} max={1825} value={custom.days} onChange={(e) => setCustom({ ...custom, days: Math.min(1825, Math.max(0, Math.floor(+e.target.value || 0))) })} /></div>
              <div className="field"><label htmlFor="co-h">{t("rem.hours")}</label><input id="co-h" type="number" inputMode="numeric" min={0} max={23} value={custom.hours} onChange={(e) => setCustom({ ...custom, hours: Math.min(23, Math.max(0, Math.floor(+e.target.value || 0))) })} /></div>
              <div className="field"><label htmlFor="co-m">{t("rem.minutes")}</label><input id="co-m" type="number" inputMode="numeric" min={0} max={59} value={custom.minutes} onChange={(e) => setCustom({ ...custom, minutes: Math.min(59, Math.max(0, Math.floor(+e.target.value || 0))) })} /></div>
            </div>
            <p className="hint">{t("rem.customHint", { label: offsetLabel(offsetFromParts(custom.days, custom.hours, custom.minutes), lang) })}</p>
            <button type="button" className="btn btn-secondary btn-sm" disabled={v.offsets.includes(offsetFromParts(custom.days, custom.hours, custom.minutes))} onClick={() => toggle(offsetFromParts(custom.days, custom.hours, custom.minutes))}>{t("rem.addCustom")}</button>
          </fieldset>

          <fieldset className="mt">
            <legend className="label">{t("rem.deliveryChannel")}</legend>
            <div className="choice-row" role="radiogroup">
              {([["sms"], ["whatsapp"], ["sms", "whatsapp"]] as Array<Array<"sms" | "whatsapp">>).map((opt) => {
                const key = opt.join("+");
                const needsWa = opt.includes("whatsapp");
                const selected = v.channels.length === opt.length && opt.every((c) => v.channels.includes(c));
                return (
                  <label key={key} className={`choice ${selected ? "selected" : ""} ${needsWa && !whatsapp.available ? "disabled" : ""}`}>
                    <input type="radio" name="channels" checked={selected} disabled={needsWa && !whatsapp.available} onChange={() => set("channels", opt)} />
                    <span>{key === "sms" ? t("channel.smsOnly") : key === "whatsapp" ? t("channel.waOnly") : t("channel.both")}</span>
                  </label>
                );
              })}
            </div>
            {!whatsapp.available && <p className="hint mb-0">{t("channel.waComingSoon")}</p>}
            {v.channels.includes("whatsapp") && !whatsapp.optedIn && (
              <label className="row small mt"><input type="checkbox" checked={Boolean(v.whatsappConsent)} onChange={(e) => set("whatsappConsent", e.target.checked)} /> {t("channel.waConsent")}</label>
            )}
          </fieldset>
          {error && <div className="alert bad mt" role="alert">{error}</div>}
          <div className="row between mt">
            <button type="button" className="btn btn-secondary" onClick={() => setStep(1)}>{t("rem.back")}</button>
            <button type="button" className="btn btn-primary" disabled={busy || v.offsets.length === 0 || (v.channels.includes("whatsapp") && !whatsapp.optedIn && !v.whatsappConsent)} onClick={loadPreview}>{busy ? <span className="spinner" /> : <Icon name="receipt" size={16} />} {t("rem.preview")}</button>
          </div>
        </section>
      )}

      {step === 3 && preview && (
        <section className="card">
          <div className="row between">
            <h2 className="mb-0">{t("rem.step.review")}</h2>
            <span className="badge info">{t("rem.oneSms")}</span>
          </div>
          <p className="mt">
            <strong>{v.label}</strong> · {t("rem.expires")}: <strong>{formatDate(preview.expiry.utc, prefs)}</strong>{" "}
            <span className="muted">({formatDate(preview.expiry.utc, { ...prefs, date: prefs.date === "BS" ? "AD" : "BS" })}) · {preview.expiry.local.slice(11)} NPT</span>
          </p>
          {preview.warnings.map((w) => (
            <div key={w} className={`alert ${w === "insufficient_credits" || w === "bs_date_needs_confirmation" ? "warn" : "info"}`}><Icon name="info" /> <span>{t(`warn.${w}` as MessageKey)}</span></div>
          ))}
          <ol className="sms-preview-list">
            {preview.lines.map((l) => (
              <li key={l.offsetMinutes} className="sms-preview-item">
                <div className="row between">
                  <span><ChannelBadge channel={l.channel} /> <strong>{formatDate(l.due.utc, prefs)}</strong> <span className="small muted">{l.due.local.slice(11)} · {offsetLabel(l.offsetMinutes, lang)}</span></span>
                  <span className="small nowrap">{localizeNumber(l.credits, lang)} {t("common.credits")}</span>
                </div>
                <pre className={`sms ${l.channel === "whatsapp" ? "sms-wa" : ""}`}>{l.smsText}</pre>
                {l.channel === "whatsapp"
                  ? <span className="small muted">{t("rem.waTemplate")}: <span className="mono">{l.whatsappTemplate?.name}</span> ({l.whatsappTemplate?.language})</span>
                  : <span className="small muted">{l.encoding} · {l.smsText.length}/160 · {l.segments} SMS</span>}
              </li>
            ))}
          </ol>
          <div className="cost-table mt">
            {preview.channels.map((ch) => {
              const c = preview.byChannel[ch];
              return c ? (
                <div key={ch} className="row between"><span><ChannelBadge channel={ch} /> {localizeNumber(c.messages, lang)} × {localizeNumber(c.creditsPerUnit, lang)} {t("common.credits")} {t("rem.perMessage")}</span><strong>{localizeNumber(c.credits, lang)}</strong></div>
              ) : null;
            })}
            {preview.channels.length > 1 && <div className="row between total"><span>{t("rem.combinedCost")}</span><strong>{localizeNumber(preview.totalCredits, lang)} {t("common.credits")}</strong></div>}
          </div>
          <div className="grid grid-3 mt">
            <div className="stat"><div className="label">{t("rem.total")}</div><div className="value">{localizeNumber(preview.totalCredits, lang)}</div><div className="sub">{t("common.credits")}</div></div>
            <div className="stat"><div className="label">{t("rem.reservedNow")}</div><div className="value">{localizeNumber(preview.reservedOnConfirmCredits, lang)}</div></div>
            <div className="stat"><div className="label">{t("rem.available")}</div><div className="value">{localizeNumber(preview.wallet.available, lang)}</div></div>
          </div>
          <p className="hint mt">{t("rem.reserveNote")}</p>
          {v.calendar === "BS" && (
            <label className="row small alert warn"><input type="checkbox" checked={bsConfirmed} onChange={(e) => setBsConfirmed(e.target.checked)} /> <span>{t("rem.bsConfirm")} <strong>{formatDate(preview.expiry.utc, { lang, date: "BS" })} = {formatDate(preview.expiry.utc, { lang, date: "AD" })}</strong></span></label>
          )}
          {error && <div className="alert bad" role="alert">{error}</div>}
          <div className="row between mt">
            <button type="button" className="btn btn-secondary" onClick={() => setStep(2)}>{t("rem.back")}</button>
            {!preview.sufficient && (
              <button type="button" className="btn btn-accent btn-lg" onClick={() => setTopup({ needed: preview.reservedOnConfirmCredits, available: preview.wallet.available, shortfall: preview.shortfallCredits })}>
                <Icon name="wallet" size={18} /> {t("topup.needTitle")}
              </button>
            )}
            <button type="button" className="btn btn-primary btn-lg" disabled={busy || preview.lines.length === 0 || !preview.sufficient || (v.calendar === "BS" && !bsConfirmed)} onClick={confirm}>{busy ? <span className="spinner" /> : <Icon name="check" size={18} />} {renewalId ? t("rem.save") : t("rem.confirm")}</button>
          </div>
        </section>
      )}

      {topup && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="topup-title" onClick={(e) => e.target === e.currentTarget && setTopup(null)}>
          <div className="modal">
            <div className="row" style={{ gap: 12 }}>
              <span className="icon-chip" style={{ background: "#fff1e6", color: "var(--accent-orange)" }}><Icon name="wallet" size={20} /></span>
              <h2 id="topup-title" className="mb-0">{topup.locked ? t("lock.title") : t("topup.needTitle")}</h2>
            </div>
            <p className="mt">{topup.locked ? t("lock.body", { balance: localizeNumber(topup.available, lang), min: localizeNumber(-5, lang) }) : t("topup.needBody")}</p>
            {!topup.locked && (
              <dl className="kv">
                <dt>{t("topup.needed")}</dt><dd><strong>{localizeNumber(topup.needed, lang)}</strong> {t("common.credits")}</dd>
                <dt>{t("rem.available")}</dt><dd>{localizeNumber(topup.available, lang)} {t("common.credits")}</dd>
                <dt>{t("topup.short")}</dt><dd><strong>{localizeNumber(topup.shortfall, lang)}</strong> {t("common.credits")}</dd>
              </dl>
            )}
            <p className="hint">{t("topup.noSave")}</p>
            <div className="row between mt">
              <button type="button" className="btn btn-secondary" onClick={() => setTopup(null)}>{t("rem.back")}</button>
              <button type="button" className="btn btn-primary" onClick={() => saveDraftAndTopUp(Math.max(topupMin, topup.shortfall))}>
                <Icon name="wallet" size={18} /> {t("topup.cta", { amount: localizeNumber(Math.max(topupMin, topup.shortfall), lang) })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TemplateCard({ tpl, lang, onPick }: { tpl: TemplateOption; lang: "ne" | "en"; onPick: (t: TemplateOption) => void }) {
  return (
    <button type="button" className="tpl" onClick={() => onPick(tpl)}>
      <span className="avatar-icon" style={{ width: 34, height: 34 }}><Icon name={iconForGroup(tpl.group_key)} size={18} /></span>
      <span>
        <span className="name">{lang === "ne" ? tpl.name_ne : tpl.name_en}</span><br />
        <span className="desc">{lang === "ne" ? tpl.name_en : tpl.name_ne}</span>
      </span>
    </button>
  );
}

/** BS date as three selects bounded by the real month lengths (no free-text parsing). */
function BsDateInput({ value, onChange, lang }: { value: string; onChange: (s: string) => void; lang: "ne" | "en" }) {
  const today = adToBs((() => { const d = new Date(Date.now() + 345 * 60_000); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; })());
  const parsed = value ? value.split("-").map(Number) : null;
  const [ym, setYm] = useState({ y: parsed?.[0] ?? today.year, m: parsed?.[1] ?? today.month });
  const d = parsed?.[2] ?? 0;
  const dim = bsDaysInMonth(ym.y, ym.m) ?? 30;
  const emit = (yy: number, mm: number, dd: number) => {
    setYm({ y: yy, m: mm });
    const max = bsDaysInMonth(yy, mm) ?? 30;
    onChange(dd ? `${yy}-${pad(mm)}-${pad(Math.min(dd, max))}` : "");
  };
  const years: number[] = [];
  for (let yy = Math.max(BS_MIN_YEAR, today.year - 1); yy <= Math.min(BS_MAX_YEAR, today.year + 15); yy++) years.push(yy);
  const months = lang === "ne" ? BS_MONTHS_NE : BS_MONTHS_EN;
  return (
    <div className="grid" style={{ gridTemplateColumns: "1fr 1.4fr 1fr", gap: 8 }}>
      <select aria-label="BS year" value={ym.y} onChange={(e) => emit(+e.target.value, ym.m, d)}>{years.map((yy) => <option key={yy} value={yy}>{localizeNumber(String(yy), lang)}</option>)}</select>
      <select aria-label="BS month" value={ym.m} onChange={(e) => emit(ym.y, +e.target.value, d)}>{months.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}</select>
      <select aria-label="BS day" value={d || ""} onChange={(e) => emit(ym.y, ym.m, +e.target.value)}>
        <option value="">—</option>
        {Array.from({ length: dim }, (_, i) => i + 1).map((dd) => <option key={dd} value={dd}>{localizeNumber(String(dd), lang)}</option>)}
      </select>
    </div>
  );
}
