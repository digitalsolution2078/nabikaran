"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";

interface Topup { min_npr: number; max_npr: number; quick_amounts: number[] }
interface Qr { enabled: boolean; image_path: string; network: string; merchant_name: string; terminal_id: string; verified: boolean }

export function SettingsEditor({ topup, qr }: { topup: Topup; qr: Qr }) {
  const router = useRouter();
  const [t, setT] = useState({ min: String(topup.min_npr), max: String(topup.max_npr), quick: topup.quick_amounts.join(", ") });
  const [q, setQ] = useState<Qr>(qr);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function save(key: "topup" | "manual_qr") {
    setMsg(null);
    const value = key === "topup"
      ? { min_npr: Number(t.min), max_npr: Number(t.max), quick_amounts: t.quick.split(",").map((s) => Number(s.trim())).filter((n) => n > 0) }
      : q;
    if (key === "manual_qr" && q.verified && !qr.verified && !confirm(`Confirm that "${q.merchant_name}" (${q.network} ${q.terminal_id}) is the business's own merchant account and payments to it reach Nabikaran.`)) return;
    try {
      await api("/api/admin/settings", { method: "POST", json: { key, value } });
      setMsg({ tone: "ok", text: "Saved and recorded in the audit log." });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    }
  }

  return (
    <>
      {msg && <div className={`alert ${msg.tone}`} role="status">{msg.text}</div>}
      <section className="card">
        <h2>Top-up limits</h2>
        <div className="grid grid-3">
          <div className="field"><label htmlFor="min">Minimum (NPR)</label><input id="min" type="number" value={t.min} onChange={(e) => setT({ ...t, min: e.target.value })} /></div>
          <div className="field"><label htmlFor="max">Maximum (NPR)</label><input id="max" type="number" value={t.max} onChange={(e) => setT({ ...t, max: e.target.value })} /></div>
          <div className="field"><label htmlFor="quick">Quick amounts</label><input id="quick" type="text" value={t.quick} onChange={(e) => setT({ ...t, quick: e.target.value })} /></div>
        </div>
        <button className="btn btn-primary" onClick={() => save("topup")}>Save limits</button>
      </section>
      <section className="card">
        <h2>QR payment destination</h2>
        <div className="alert warn"><span>The QR is a <strong>static Fonepay merchant QR</strong> (EMVCo, point-of-initiation “11”). It carries no amount or remarks, so the app shows the amount and a unique reference beside it. Generating dynamic QRs requires Fonepay&apos;s merchant API — do not edit the payload by hand.</span></div>
        <div className="grid grid-2">
          <div className="field"><label htmlFor="mname">Merchant name (as printed on the QR)</label><input id="mname" type="text" value={q.merchant_name} onChange={(e) => setQ({ ...q, merchant_name: e.target.value })} /></div>
          <div className="field"><label htmlFor="term">Terminal / merchant ID</label><input id="term" type="text" value={q.terminal_id} onChange={(e) => setQ({ ...q, terminal_id: e.target.value })} /></div>
          <div className="field"><label htmlFor="net">Network</label><input id="net" type="text" value={q.network} onChange={(e) => setQ({ ...q, network: e.target.value })} /></div>
          <div className="field"><label htmlFor="img">QR image path (in /public)</label><input id="img" type="text" value={q.image_path} onChange={(e) => setQ({ ...q, image_path: e.target.value })} /></div>
        </div>
        <label className="row"><input type="checkbox" checked={q.enabled} onChange={(e) => setQ({ ...q, enabled: e.target.checked })} /> QR top-up enabled for customers</label>
        <label className="row mt"><input type="checkbox" checked={q.verified} onChange={(e) => setQ({ ...q, verified: e.target.checked })} /> I verified this merchant account belongs to the business (removes the customer warning)</label>
        <div className="mt"><button className="btn btn-primary" onClick={() => save("manual_qr")}>Save QR settings</button></div>
      </section>
    </>
  );
}
