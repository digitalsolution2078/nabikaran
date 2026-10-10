"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";
import { localizeNumber } from "@/lib/i18n/format";

export function ProActions({ price, available, canTrial, trialDays, trialUsed, isPro, isTrial }: { price: number; available: number; canTrial: boolean; trialDays: number; trialUsed: boolean; isPro: boolean; isTrial: boolean }) {
  const { t, prefs } = usePrefs();
  const router = useRouter();
  const [busy, setBusy] = useState<"trial" | "buy" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const n = (x: number) => localizeNumber(x, prefs.lang);
  const short = Math.max(0, price - available);

  async function trial() {
    setBusy("trial");
    setMsg(null);
    try {
      await api("/api/pro", { method: "POST", json: { action: "trial" } });
      setMsg({ ok: true, text: t("pro.trialStarted") });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function buy() {
    if (!window.confirm(t("pro.confirmBuy", { n: n(price) }))) return;
    setBusy("buy");
    setMsg(null);
    try {
      await api("/api/pro", { method: "POST", json: { action: "buy", idempotencyKey: key } });
      setMsg({ ok: true, text: t("pro.bought") });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      {canTrial && (
        <div>
          <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={trial}>{busy === "trial" ? <span className="spinner" /> : <Icon name="sparkle" size={16} />} {t("pro.startTrial", { n: n(trialDays) })}</button>
          <p className="hint">{t("pro.trialNote", { n: n(trialDays) })}</p>
        </div>
      )}
      {!canTrial && trialUsed && !isPro && <p className="hint">{t("pro.trialUsed")}</p>}
      <div>
        {short > 0 ? (
          <Link className="btn btn-primary" href={`/wallet?amount=${short}&next=${encodeURIComponent("/pro")}`}><Icon name="wallet" size={16} /> {t("pro.topUpFirst", { n: n(short) })}</Link>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={buy}>{busy === "buy" ? <span className="spinner" /> : <Icon name="star" size={16} />} {isPro && !isTrial ? t("pro.buyExtend", { n: n(price) }) : t("pro.buy", { n: n(price) })}</button>
        )}
        <p className="hint">{t("pro.paidFromWallet", { n: n(available) })}</p>
      </div>
      {msg && <div className={`alert ${msg.ok ? "ok" : "bad"}`} role="status">{msg.text}</div>}
    </div>
  );
}
