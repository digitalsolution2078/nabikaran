"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import { usePrefs } from "./Prefs";
import { Icon } from "./Icon";
import { localizeNumber } from "@/lib/i18n/format";

/** Wallet: redeem a coupon code or gift card. */
export function RedeemCode({ initialCode = "" }: { initialCode?: string }) {
  const { t, prefs } = usePrefs();
  const router = useRouter();
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function redeem(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ credits: number; source: "admin" | "gift"; fromName: string | null; message: string | null }>("/api/wallet/redeem", { method: "POST", json: { code } });
      const credits = localizeNumber(r.credits, prefs.lang);
      let text = t("redeem.done", { credits });
      if (r.source === "gift") text = r.fromName ? t("redeem.giftFrom", { credits, name: r.fromName }) : t("redeem.gift", { credits });
      if (r.message) text += ` “${r.message}”`;
      setMsg({ ok: true, text });
      setCode("");
      router.refresh();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" id="redeem" aria-labelledby="redeem-h">
      <h2 id="redeem-h"><Icon name="gift" size={18} /> {t("redeem.title")}</h2>
      <p className="muted">{t("redeem.intro")}</p>
      <form className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={redeem}>
        <div className="field mb-0 grow" style={{ minWidth: 200 }}>
          <label htmlFor="redeem-code">{t("redeem.code")}</label>
          <input id="redeem-code" type="text" value={code} maxLength={40} autoComplete="off" autoCapitalize="characters" spellCheck={false}
            placeholder="XXXX-XXXX-XXXX" className="mono" onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </div>
        <button className="btn btn-primary" disabled={busy || code.replace(/[\s-]/g, "").length < 4}>{busy ? <span className="spinner" /> : <Icon name="check" size={16} />} {t("redeem.button")}</button>
      </form>
      {msg && <div className={`alert ${msg.ok ? "ok" : "bad"} mt`} role="status">{msg.text}</div>}
    </section>
  );
}
