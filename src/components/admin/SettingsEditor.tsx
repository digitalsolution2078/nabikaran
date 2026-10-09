"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";

interface Topup { min_npr: number; max_npr: number; quick_amounts: number[] }
interface Signin { fee_credits: number; min_balance: number; charge_staff: boolean }
interface Qr { enabled: boolean; image_path: string; network: string; merchant_name: string; terminal_id: string; verified: boolean }

export function SettingsEditor({ topup, qr, signin, dynamicQr }: { topup: Topup; qr: Qr; signin: Signin; dynamicQr: boolean }) {
  const router = useRouter();
  const [t, setT] = useState({ min: String(topup.min_npr), max: String(topup.max_npr), quick: topup.quick_amounts.join(", ") });
  const [q, setQ] = useState<Qr>(qr);
  const [sg, setSg] = useState({ fee: String(signin.fee_credits), min: String(signin.min_balance), staff: signin.charge_staff });
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function save(key: "topup" | "manual_qr" | "signin") {
    setMsg(null);
    const value = key === "topup"
      ? { min_npr: Number(t.min), max_npr: Number(t.max), quick_amounts: t.quick.split(",").map((s) => Number(s.trim())).filter((n) => n > 0) }
      : key === "signin"
        ? { fee_credits: Number(sg.fee), min_balance: Number(sg.min), charge_staff: sg.staff }
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
        <h2>Sign-in SMS fee</h2>
        <p className="small muted">Charged once per successful sign-in. The balance may go negative; the next top-up settles it. Below the floor, customers can still sign in and top up but cannot add, edit or resume reminders.</p>
        <div className="grid grid-3">
          <div className="field"><label htmlFor="sfee">Credits per sign-in (0 = free)</label><input id="sfee" type="number" min={0} max={10} value={sg.fee} onChange={(e) => setSg({ ...sg, fee: e.target.value })} /></div>
          <div className="field"><label htmlFor="smin">Lock below balance</label><input id="smin" type="number" max={0} min={-1000} value={sg.min} onChange={(e) => setSg({ ...sg, min: e.target.value })} /></div>
          <div className="field"><span className="label">Staff</span><label className="row small"><input type="checkbox" checked={sg.staff} onChange={(e) => setSg({ ...sg, staff: e.target.checked })} /> Charge admins too</label></div>
        </div>
        <button className="btn btn-primary" onClick={() => save("signin")}>Save sign-in fee</button>
      </section>
      <section className="card">
        <h2>QR payment destination</h2>
        {dynamicQr
          ? <div className="alert ok"><span><strong>Fonepay dynamic QR is active.</strong> Each top-up gets a Fonepay-generated QR with the exact amount, and credits are added automatically when Fonepay confirms the payment. The static QR below is only a fallback if the Fonepay API is unreachable.</span></div>
          : <div className="alert info"><span><strong>Dynamic QR is off.</strong> Set FONEPAY_MODE=live and the four FONEPAY_* credentials from your Fonepay merchant account in <code>.env.production</code> to enable automatic QR payments.</span></div>}
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
