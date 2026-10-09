"use client";
import { useState } from "react";
import { api } from "./api";

export function TopupPacks({ packs }: { packs: { code: string; amountPaisa: number; credits: number }[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function buy(code: string) {
    setBusy(code); setError(null);
    try {
      const r = await api<{ paymentUrl: string }>("/api/topups", { method: "POST", json: { packCode: code } });
      window.location.href = r.paymentUrl;
    } catch (e) { setError((e as Error).message); setBusy(null); }
  }
  return (
    <div>
      <div className="grid">
        {packs.map((p) => (
          <div className="stat" key={p.code}>
            <div className="n">NPR {p.amountPaisa / 100}</div>
            <div className="l">{p.credits} credits · never expire</div>
            <button style={{ marginTop: 8 }} disabled={busy !== null} onClick={() => buy(p.code)}>{busy === p.code ? "Opening checkout…" : "Top up with Khalti"}</button>
          </div>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <p className="muted" style={{ fontSize: 13 }}>1 credit = NPR 1 of stored value. Credits are issued only after the payment is verified with the gateway.</p>
    </div>
  );
}
