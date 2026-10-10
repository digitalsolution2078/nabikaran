"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import type { ReferralSettings, PinSettings } from "@/lib/services/settings";

export function GrowthSettings({ referral, pin }: { referral: ReferralSettings; pin: PinSettings }) {
  const router = useRouter();
  const [r, setR] = useState({ ...referral, rc: String(referral.referrer_credits), ec: String(referral.referee_credits), min: String(referral.min_topup_npr), cap: String(referral.max_rewards_per_referrer) });
  const [p, setP] = useState({ enabled: pin.enabled, attempts: String(pin.max_attempts) });
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function save(key: "referral" | "pin") {
    setMsg(null);
    const value = key === "referral"
      ? { enabled: r.enabled, referrer_credits: Number(r.rc), referee_credits: Number(r.ec), min_topup_npr: Number(r.min), max_rewards_per_referrer: Number(r.cap), message: r.message }
      : { enabled: p.enabled, max_attempts: Number(p.attempts) };
    try {
      await api("/api/admin/settings", { method: "POST", json: { key, value } });
      setMsg({ tone: "ok", text: "Saved and recorded in the audit log." });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    }
  }

  const perReward = Number(r.rc || 0) + Number(r.ec || 0);
  return (
    <>
      {msg && <div className={`alert ${msg.tone}`} role="status">{msg.text}</div>}
      <section className="card">
        <h2>Referral programme</h2>
        <p className="small muted">Customers share nabikaran.org/r/CODE. A new account opened from the link is recorded as invited. When that customer&apos;s paid top-ups reach the minimum, both get their bonus credits, once. Sign-ups alone earn nothing, so fake accounts cannot farm credits.</p>
        <label className="row small" style={{ marginBottom: 10 }}><input type="checkbox" checked={r.enabled} onChange={(e) => setR({ ...r, enabled: e.target.checked })} /> <strong>Programme on</strong></label>
        <div className="grid grid-2">
          <div className="field"><label htmlFor="r-rc">Credits for the inviter</label><input id="r-rc" type="number" min={0} max={1000} value={r.rc} onChange={(e) => setR({ ...r, rc: e.target.value })} /></div>
          <div className="field"><label htmlFor="r-ec">Credits for the new customer</label><input id="r-ec" type="number" min={0} max={1000} value={r.ec} onChange={(e) => setR({ ...r, ec: e.target.value })} /></div>
          <div className="field"><label htmlFor="r-min">Qualifying paid top-ups (NPR)</label><input id="r-min" type="number" min={1} value={r.min} onChange={(e) => setR({ ...r, min: e.target.value })} /><span className="hint">The new customer&apos;s total paid top-ups must reach this.</span></div>
          <div className="field"><label htmlFor="r-cap">Most rewards per inviter</label><input id="r-cap" type="number" min={0} value={r.cap} onChange={(e) => setR({ ...r, cap: e.target.value })} /><span className="hint">After this, invitees still get their bonus; the inviter does not.</span></div>
        </div>
        <div className="field"><label htmlFor="r-msg">Extra line on the invite card (optional)</label><input id="r-msg" type="text" maxLength={200} value={r.message} onChange={(e) => setR({ ...r, message: e.target.value })} placeholder="Dashain offer: invite 3 friends this month!" /></div>
        <p className="hint">Cost per successful referral: <strong>{perReward}</strong> credits (NPR {perReward}), paid only after the new customer has topped up at least NPR {r.min}.</p>
        <button className="btn btn-primary" onClick={() => save("referral")}>Save referral settings</button>
      </section>
      <section className="card">
        <h2>PIN sign-in</h2>
        <p className="small muted">Customers may set a 4–6 digit PIN in Settings and sign in with mobile + PIN, with no SMS and so no sign-in fee. A PIN locks after the number of wrong tries below, and only a normal SMS-code sign-in unlocks it. Staff accounts always use SMS codes.</p>
        <div className="grid grid-2">
          <div className="field"><span className="label">Availability</span><label className="row small"><input type="checkbox" checked={p.enabled} onChange={(e) => setP({ ...p, enabled: e.target.checked })} /> Allow PIN sign-in</label></div>
          <div className="field"><label htmlFor="p-max">Wrong tries before lock</label><input id="p-max" type="number" min={3} max={10} value={p.attempts} onChange={(e) => setP({ ...p, attempts: e.target.value })} /></div>
        </div>
        <button className="btn btn-primary" onClick={() => save("pin")}>Save PIN settings</button>
      </section>
    </>
  );
}
