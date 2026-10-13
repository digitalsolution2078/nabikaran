"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import type { ReferralSettings, PinSettings, LowCreditSettings } from "@/lib/services/settings";

export function GrowthSettings({ referral, pin, lowCredit }: { referral: ReferralSettings; pin: PinSettings; lowCredit: LowCreditSettings }) {
  const router = useRouter();
  const [r, setR] = useState({ ...referral, rc: String(referral.referrer_credits), ec: String(referral.referee_credits), min: String(referral.min_topup_npr), cap: String(referral.max_rewards_per_referrer) });
  const [p, setP] = useState({ enabled: pin.enabled, attempts: String(pin.max_attempts) });
  const [lc, setLc] = useState({ enabled: lowCredit.enabled, sms: lowCredit.sms_last_call, days: String(lowCredit.last_call_days) });
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function save(key: "referral" | "pin" | "low_credit") {
    setMsg(null);
    const value = key === "referral"
      ? { enabled: r.enabled, referrer_credits: Number(r.rc), referee_credits: Number(r.ec), min_topup_npr: Number(r.min), max_rewards_per_referrer: Number(r.cap), message: r.message }
      : key === "pin"
        ? { enabled: p.enabled, max_attempts: Number(p.attempts) }
        : { enabled: lc.enabled, sms_last_call: lc.sms, last_call_days: Number(lc.days) };
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
      <section className="card">
        <h2>Low-credit alerts</h2>
        <p className="small muted">When a customer&apos;s reminders cannot be sent for lack of credits, they are told with the exact top-up amount: when it is first noticed, 7 days before the first waiting reminder, and a last call. App notifications and email are free; the optional SMS at the last call costs you one SMS. At most one alert per customer per day, between 8 am and 8 pm Nepal time.</p>
        <div className="grid grid-2">
          <div className="field"><span className="label">Alerts</span><label className="row small"><input type="checkbox" checked={lc.enabled} onChange={(e) => setLc({ ...lc, enabled: e.target.checked })} /> Send low-credit alerts</label></div>
          <div className="field"><span className="label">Last call by SMS</span><label className="row small"><input type="checkbox" checked={lc.sms} onChange={(e) => setLc({ ...lc, sms: e.target.checked })} /> Also send one SMS at the last call</label></div>
          <div className="field"><label htmlFor="lc-days">Last call (days before the first waiting reminder)</label><input id="lc-days" type="number" min={1} max={6} value={lc.days} onChange={(e) => setLc({ ...lc, days: e.target.value })} /></div>
        </div>
        <button className="btn btn-primary" onClick={() => save("low_credit")}>Save alert settings</button>
      </section>
    </>
  );
}
