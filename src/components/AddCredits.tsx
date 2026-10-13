"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";
import { localizeNumber } from "@/lib/i18n/format";
import { bonusFor, nextTier, type BonusTier } from "@/lib/bonus";

export function AddCredits({ min, max, quick, qrEnabled, khaltiEnabled, esewaEnabled = false, initialAmount, qrAutomatic = false, tiers = [] }: { min: number; max: number; quick: number[]; qrEnabled: boolean; khaltiEnabled: boolean; esewaEnabled?: boolean; initialAmount?: number; qrAutomatic?: boolean; tiers?: BonusTier[] }) {
  const router = useRouter();
  const { t, prefs } = usePrefs();
  const [amount, setAmount] = useState<string>(String(initialAmount ?? quick[1] ?? quick[0] ?? min));
  const [method, setMethod] = useState<"qr" | "khalti" | "esewa">(khaltiEnabled ? "khalti" : esewaEnabled ? "esewa" : "qr");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Number(amount);
  const valid = Number.isInteger(n) && n >= min && n <= max;
  const bonus = valid ? bonusFor(n, tiers) : 0;
  const next = valid ? nextTier(n, tiers) : null;

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ paymentUrl?: string; next?: string }>("/api/topups", { method: "POST", json: { amountNpr: n, method } });
      if (r.paymentUrl) window.location.href = r.paymentUrl;
      else if (r.next) router.push(r.next);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={go} noValidate>
      <div className="chips" style={{ marginBottom: 12 }}>
        {quick.map((q) => (
          <button type="button" key={q} className="chip" aria-pressed={n === q} onClick={() => setAmount(String(q))}>
            {t("common.npr")} {localizeNumber(q, prefs.lang)}
            {bonusFor(q, tiers) > 0 && <span className="chip-bonus">+{localizeNumber(bonusFor(q, tiers), prefs.lang)}</span>}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="amount">{t("wallet.amount")}</label>
        <div className="input-affix">
          <span>{t("common.npr")}</span>
          <input id="amount" type="number" inputMode="numeric" min={min} max={max} step={1} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} aria-invalid={amount !== "" && !valid} aria-describedby="amount-hint" style={{ fontSize: 18, fontWeight: 600 }} />
        </div>
        <span id="amount-hint" className="hint">{t("wallet.min", { min: localizeNumber(min, prefs.lang), max: localizeNumber(max, prefs.lang) })}</span>
        {valid && (
          <div className="you-get" aria-live="polite">
            <span className="you-get-total">{t("wallet.youGet", { n: localizeNumber(n + bonus, prefs.lang) })}</span>
            {bonus > 0 && <span className="badge ok">{t("wallet.bonusIncl", { bonus: localizeNumber(bonus, prefs.lang) })}</span>}
          </div>
        )}
        {next && <button type="button" className="bonus-nudge" onClick={() => setAmount(String(next.minNpr))}><Icon name="gift" size={14} /> {t("wallet.bonusNudge", { more: localizeNumber(next.minNpr - n, prefs.lang), pct: localizeNumber(next.percent, prefs.lang) })}</button>}
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: "0 0 14px" }}>
        <legend className="label" style={{ marginBottom: 6 }}>{t("wallet.method")}</legend>
        <div className="stack" style={{ gap: 8 }}>
          {qrEnabled && (
            <label className="choice"><input type="radio" name="method" checked={method === "qr"} onChange={() => setMethod("qr")} /><span><strong><Icon name="qr" size={16} /> {t("wallet.qr")}</strong><br /><span className="small muted">{qrAutomatic ? t("wallet.qrAuto") : t("wallet.qrd")}</span></span></label>
          )}
          {khaltiEnabled && (
            <label className="choice"><input type="radio" name="method" checked={method === "khalti"} onChange={() => setMethod("khalti")} /><span><strong><Icon name="wallet" size={16} /> {t("wallet.khalti")}</strong> <span className="badge ok">{t("wallet.instant")}</span><br /><span className="small muted">{t("wallet.khaltid")}</span></span></label>
          )}
          {esewaEnabled && (
            <label className="choice"><input type="radio" name="method" checked={method === "esewa"} onChange={() => setMethod("esewa")} /><span><strong><Icon name="wallet" size={16} /> eSewa</strong> <span className="badge ok">{t("wallet.instant")}</span><br /><span className="small muted">{t("wallet.esewad")}</span></span></label>
          )}
        </div>
      </fieldset>
      {error && <div className="alert bad" role="alert">{error}</div>}
      <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={!valid || busy}>
        {busy ? <span className="spinner" /> : <Icon name="arrowRight" size={18} />} {t("wallet.continue")}
      </button>
      <p className="hint mt mb-0">{t("wallet.noExpiry")}</p>
    </form>
  );
}
