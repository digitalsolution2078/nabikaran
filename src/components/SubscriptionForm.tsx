"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";
import { formatDate, offsetLabel } from "@/lib/i18n/format";
import { kathmanduToUtc } from "@/lib/time";
import type { MessageKey } from "@/lib/i18n/dict";

const QUICK: Array<{ name: string; cycle: 1 | 3 | 6 | 12; currency?: string }> = [
  { name: "Netflix", cycle: 1, currency: "USD" },
  { name: "YouTube Premium", cycle: 1 },
  { name: "Spotify", cycle: 1 },
  { name: "ChatGPT Plus", cycle: 1, currency: "USD" },
  { name: "Canva Pro", cycle: 12 },
  { name: "Google One", cycle: 1 },
  { name: "WorldLink", cycle: 12 },
  { name: "Vianet", cycle: 12 },
  { name: "DishHome", cycle: 12 },
  { name: "Ncell pack", cycle: 1 },
  { name: "NTC pack", cycle: 1 },
  { name: "Domain", cycle: 12, currency: "USD" },
  { name: "Hosting", cycle: 12 },
  { name: "Insurance premium", cycle: 12 },
];
const CURRENCIES = ["NPR", "USD", "INR", "EUR", "GBP", "AUD"];
const OFFSETS = [7 * 1440, 3 * 1440, 1440, 0];

/** Pro: add a subscription (a repeating reminder with amount and payment method). */
export function SubscriptionForm({ emailAvailable }: { emailAvailable: boolean }) {
  const { t, prefs } = usePrefs();
  const router = useRouter();
  const [f, setF] = useState({ label: "", amount: "", currency: "NPR", cycle: 1 as 1 | 3 | 6 | 12, date: "", payment: "", autoRenew: true, offsets: [7 * 1440, 1440], email: false });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [short, setShort] = useState<number | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((o) => ({ ...o, [k]: v }));

  const preview = (() => {
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return null;
      const [y, m, d] = f.date.split("-").map(Number);
      return formatDate(kathmanduToUtc({ year: y, month: m, day: d }, "09:00"), { lang: prefs.lang, date: "BS" });
    } catch {
      return null;
    }
  })();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setShort(null);
    try {
      await api("/api/renewals", {
        method: "POST",
        json: {
          category: "subscription",
          label: f.label.trim(),
          calendar: "AD",
          expiryDate: f.date,
          localTime: "09:00",
          offsets: f.offsets,
          channels: f.email ? ["sms", "email"] : ["sms"],
          repeatYearly: f.cycle === 12,
          repeatMonths: f.cycle === 12 ? null : f.cycle,
          subscription: { amount: f.amount === "" ? null : Number(f.amount), currency: f.currency, paymentMethod: f.payment.trim() || null, autoRenew: f.autoRenew },
          idempotencyKey: key,
        },
      });
      setMsg({ ok: true, text: t("sub.saved") });
      setF((o) => ({ ...o, label: "", amount: "", date: "", payment: "" }));
      setKey(crypto.randomUUID());
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "insufficient_credits") setShort(Number(err.detail?.shortfallCredits ?? 1));
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <div className="field">
        <span className="label">{t("sub.quick")}</span>
        <div className="chips">
          {QUICK.map((q) => (
            <button type="button" key={q.name} className="chip" aria-pressed={f.label === q.name} onClick={() => setF((o) => ({ ...o, label: q.name, cycle: q.cycle, currency: q.currency ?? "NPR" }))}>{q.name}</button>
          ))}
        </div>
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="sub-label">{t("sub.service")}</label>
          <input id="sub-label" type="text" value={f.label} maxLength={60} placeholder={t("sub.servicePh")} onChange={(e) => set("label", e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="sub-cycle">{t("sub.cycle")}</label>
          <select id="sub-cycle" value={f.cycle} onChange={(e) => set("cycle", Number(e.target.value) as 1 | 3 | 6 | 12)}>
            {[1, 3, 6, 12].map((c) => <option key={c} value={c}>{t(`sub.cycle.${c}` as MessageKey)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sub-amount">{t("sub.amount")}</label>
          <div className="row" style={{ gap: 6 }}>
            <select aria-label={t("sub.currency")} value={f.currency} onChange={(e) => set("currency", e.target.value)} style={{ width: 90 }}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </select>
            <input id="sub-amount" type="number" inputMode="decimal" min={0} step="0.01" value={f.amount} onChange={(e) => set("amount", e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="sub-date">{t("sub.nextCharge")}</label>
          <input id="sub-date" type="date" value={f.date} onChange={(e) => set("date", e.target.value)} required />
          {preview && <span className="hint">BS: {preview}</span>}
        </div>
        <div className="field">
          <label htmlFor="sub-pay">{t("sub.payment")}</label>
          <input id="sub-pay" type="text" value={f.payment} maxLength={40} placeholder={t("sub.paymentPh")} onChange={(e) => set("payment", e.target.value)} />
        </div>
        <div className="field">
          <span className="label">{t("sub.remindBefore")}</span>
          <div className="chips">
            {OFFSETS.map((m) => (
              <button type="button" key={m} className="chip" aria-pressed={f.offsets.includes(m)} onClick={() => set("offsets", f.offsets.includes(m) ? f.offsets.filter((x) => x !== m) : [...f.offsets, m])}>{offsetLabel(m, prefs.lang)}</button>
            ))}
          </div>
        </div>
      </div>
      <label className="row small" style={{ marginBottom: 8 }}><input type="checkbox" checked={f.autoRenew} onChange={(e) => set("autoRenew", e.target.checked)} /> {t("sub.autoRenew")}</label>
      {emailAvailable && <label className="row small" style={{ marginBottom: 8 }}><input type="checkbox" checked={f.email} onChange={(e) => set("email", e.target.checked)} /> {t("channel.alsoEmail")}</label>}
      {msg && <div className={`alert ${msg.ok ? "ok" : "bad"}`} role="status">{msg.text} {short ? <Link href={`/wallet?amount=${short}&next=${encodeURIComponent("/subscriptions")}`}>{t("dash.topUp")} →</Link> : null}</div>}
      <button className="btn btn-primary" disabled={busy || !f.label.trim() || !f.date || f.offsets.length === 0}>{busy ? <span className="spinner" /> : <Icon name="plus" size={16} />} {t("sub.save")}</button>
    </form>
  );
}
