"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";
import { localizeNumber } from "@/lib/i18n/format";

/** Buy a gift card with a QR payment (never from wallet credits). */
export function GiftBuy({ min, max, qrEnabled }: { min: number; max: number; qrEnabled: boolean }) {
  const { t, prefs } = usePrefs();
  const router = useRouter();
  const quick = [100, 250, 500, 1000, 2000].filter((a) => a >= min && a <= max);
  const [amount, setAmount] = useState<number>(quick[1] ?? quick[0] ?? min);
  const [toName, setToName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const n = (v: number) => localizeNumber(v, prefs.lang);

  async function buy(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ next: string }>("/api/gifts", { method: "POST", json: { amountNpr: amount, toName: toName.trim() || null, message: message.trim() || null } });
      router.push(r.next);
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  }

  if (!qrEnabled) return <div className="alert warn"><Icon name="alert" /> {t("gift.unavailable")}</div>;
  return (
    <form onSubmit={buy}>
      <div className="field">
        <span className="label">{t("gift.amount")}</span>
        <div className="chips">
          {quick.map((a) => <button type="button" key={a} className="chip" aria-pressed={amount === a} onClick={() => setAmount(a)}>{t("common.npr")} {n(a)}</button>)}
        </div>
        <input aria-label={t("gift.amount")} type="number" inputMode="numeric" min={min} max={max} step={1} value={amount} onChange={(e) => setAmount(Math.floor(Number(e.target.value) || 0))} className="mt" />
        <span className="hint">{t("gift.amountHint", { min: n(min), max: n(max) })}</span>
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="gift-to">{t("gift.toName")}</label>
          <input id="gift-to" type="text" maxLength={60} value={toName} onChange={(e) => setToName(e.target.value)} placeholder={t("gift.toNamePh")} />
        </div>
        <div className="field">
          <label htmlFor="gift-msg">{t("gift.message")}</label>
          <input id="gift-msg" type="text" maxLength={200} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t("gift.messagePh")} />
        </div>
      </div>
      <p className="hint">{t("gift.rules")}</p>
      {err && <div className="alert bad" role="alert">{err}</div>}
      <button className="btn btn-primary" disabled={busy || amount < min || amount > max}>{busy ? <span className="spinner" /> : <Icon name="gift" size={16} />} {t("gift.buy", { npr: n(amount) })}</button>
    </form>
  );
}
