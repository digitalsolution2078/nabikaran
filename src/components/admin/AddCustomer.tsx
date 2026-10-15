"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "../api";
import { Icon } from "../Icon";

type Abilities = { paid: boolean; freeDirect: boolean; freeRequest: boolean; business?: boolean };
type Recent = { id: string; phone: string; name: string | null; createdAt: string; staff: string | null; signedIn: boolean };
type Result = {
  customer: { id: string; phone: string; name: string | null; available: number };
  credit: { kind: "none" } | { kind: "paid"; reference: string; credits: number; bonus: number } | { kind: "free"; status: "applied" | "pending"; credits: number } | { kind: "failed"; message: string };
  welcomeSms: "sent" | "failed" | "skipped";
};

const METHODS: Array<[string, string]> = [["cash", "Cash"], ["khalti", "Khalti"], ["fonepay", "Fonepay / bank QR"], ["bank", "Bank transfer"], ["other", "Other"]];
const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, "").slice(0, 32);
const empty = { phone: "", name: "", email: "", locale: "ne-NP", kind: "none", amount: "", method: "cash", receipt: "", credits: "", reason: "", sms: true, biz: false, bizName: "" };

/** Admin → Users: add a customer account and, optionally, paid or free credits in one step. */
export function AddCustomer({ can, recent }: { can: Abilities; recent: Recent[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(empty);
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; existingId?: string } | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const free = can.freeDirect || can.freeRequest;
  const amount = Math.floor(Number(f.amount) || 0);
  const credits = Math.floor(Number(f.credits) || 0);
  const creditOk = f.kind === "none" || (f.kind === "paid" && amount >= 1) || (f.kind === "free" && credits >= 1 && f.reason.trim().length >= 3);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (f.kind === "paid" && !window.confirm(`Add NPR ${amount.toLocaleString("en-IN")} (paid by ${METHODS.find(([k]) => k === f.method)?.[1]}) to the new account?\n\nOnly confirm after the money is in your hand or account.`)) return;
    setBusy(true);
    try {
      const credit = f.kind === "paid"
        ? { kind: "paid", amountNpr: amount, method: f.method, receipt: f.receipt.trim() || null, note: null }
        : f.kind === "free" ? { kind: "free", credits, reason: f.reason.trim() } : { kind: "none" };
      const r = await api<Result>("/api/admin/customers", {
        method: "POST",
        json: { phone: f.phone, name: f.name.trim() || null, email: f.email.trim() || null, locale: f.locale, credit, welcomeSms: f.sms, business: f.biz ? { name: f.bizName.trim() } : null, idempotencyKey: key },
      });
      setDone(r);
      setF(empty);
      setKey(newKey());
      router.refresh();
    } catch (e2) {
      const ex = e2 as ApiError;
      setErr({ text: ex.message, existingId: ex.code === "customer_exists" ? String((ex.detail as Record<string, unknown> | undefined)?.id ?? "") || undefined : undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <span><strong>Add a customer</strong><br /><span className="small muted">For walk-ins and phone sign-ups. The customer signs in later with an SMS code on this number.</span></span>
        {!open && <button type="button" className="btn btn-primary" onClick={() => { setOpen(true); setDone(null); }}><Icon name="plus" size={16} /> Add customer</button>}
      </div>

      {done && (
        <div className="alert ok mt" role="status">
          <Icon name="check" />
          <span>
            Account created for <strong>{done.customer.name ?? done.customer.phone}</strong> ({done.customer.phone}). Balance: {done.customer.available} credits.
            {done.credit.kind === "paid" && <> Paid top-up {done.credit.reference}: {done.credit.credits} credits{done.credit.bonus ? ` (incl. ${done.credit.bonus} bonus)` : ""}.</>}
            {done.credit.kind === "free" && (done.credit.status === "applied" ? <> {done.credit.credits} free credits added.</> : <> {done.credit.credits} free credits sent for a second admin&apos;s approval (Customers → user → Credit adjustment).</>)}
            {done.welcomeSms === "sent" && <> Welcome SMS sent.</>}
            {done.welcomeSms === "failed" && <> Welcome SMS could not be sent.</>}
            {" "}<Link href={`/admin/users/${done.customer.id}`}>Open account →</Link>
          </span>
        </div>
      )}
      {done?.credit.kind === "failed" && <div className="alert bad mt" role="alert">The account was created, but credits were not added: {done.credit.message} Add them from the account page or the Counter.</div>}

      {open && (
        <form onSubmit={submit} className="mt">
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="ac-phone">Mobile number</label>
              <input id="ac-phone" type="tel" inputMode="tel" required value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="98XXXXXXXX" />
            </div>
            <div className="field">
              <label htmlFor="ac-name">Name (optional)</label>
              <input id="ac-name" value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ac-email">Email (optional)</label>
              <input id="ac-email" type="email" value={f.email} maxLength={120} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ac-locale">SMS language</label>
              <select id="ac-locale" value={f.locale} onChange={(e) => setF({ ...f, locale: e.target.value })}><option value="ne-NP">Nepali (Romanized)</option><option value="en-NP">English</option></select>
            </div>
          </div>

          <fieldset style={{ border: 0, padding: 0, margin: "8px 0 0" }}>
            <legend className="label" style={{ marginBottom: 6 }}>Credits</legend>
            <div className="stack" style={{ gap: 8 }}>
              <label className="choice"><input type="radio" name="ac-kind" checked={f.kind === "none"} onChange={() => setF({ ...f, kind: "none" })} /><span>No credits now</span></label>
              {can.paid && <label className="choice"><input type="radio" name="ac-kind" checked={f.kind === "paid"} onChange={() => setF({ ...f, kind: "paid" })} /><span><strong>Paid</strong><br /><span className="small muted">Money received: cash, Khalti, Fonepay, bank. Recorded like a counter top-up (bonus tiers apply).</span></span></label>}
              {free && <label className="choice"><input type="radio" name="ac-kind" checked={f.kind === "free"} onChange={() => setF({ ...f, kind: "free" })} /><span><strong>Free</strong><br /><span className="small muted">{can.freeDirect ? "Complimentary credits, added at once." : "Complimentary credits; another admin approves them."}</span></span></label>}
            </div>
          </fieldset>

          {f.kind === "paid" && (
            <div className="grid grid-3 mt">
              <div className="field"><label htmlFor="ac-amount">Amount received (NPR)</label><input id="ac-amount" type="number" inputMode="numeric" min={1} step={1} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /><span className="hint">1 rupee = 1 credit.</span></div>
              <div className="field"><label htmlFor="ac-method">Paid by</label><select id="ac-method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              <div className="field"><label htmlFor="ac-receipt">Receipt / transaction no. (optional)</label><input id="ac-receipt" value={f.receipt} maxLength={40} onChange={(e) => setF({ ...f, receipt: e.target.value })} /></div>
            </div>
          )}
          {f.kind === "free" && (
            <div className="grid grid-2 mt">
              <div className="field"><label htmlFor="ac-credits">Credits</label><input id="ac-credits" type="number" inputMode="numeric" min={1} max={100000} step={1} value={f.credits} onChange={(e) => setF({ ...f, credits: e.target.value })} required /></div>
              <div className="field"><label htmlFor="ac-reason">Reason (audit log)</label><input id="ac-reason" value={f.reason} maxLength={200} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. launch offer, partner account" required /></div>
            </div>
          )}

          {can.business && (
            <div className="mt">
              <label className="row small"><input type="checkbox" checked={f.biz} onChange={(e) => setF({ ...f, biz: e.target.checked })} /> Business account: give business tools (reminders for their clients)</label>
              {f.biz && <div className="field mt"><label htmlFor="ac-biz">Business name (shown in client SMS)</label><input id="ac-biz" value={f.bizName} maxLength={20} onChange={(e) => setF({ ...f, bizName: e.target.value })} placeholder="e.g. Ram Motors" required /><span className="hint">2–20 English letters.</span></div>}
            </div>
          )}
          <label className="row small mt"><input type="checkbox" checked={f.sms} onChange={(e) => setF({ ...f, sms: e.target.checked })} /> Send a welcome SMS with the sign-in link (1 SMS, paid by Nabikaran)</label>
          {err && <div className="alert bad mt" role="alert">{err.text}{err.existingId && <> <Link href={`/admin/users/${err.existingId}`}>Open that account →</Link></>}</div>}
          <div className="row mt" style={{ gap: 8 }}>
            <button className="btn btn-primary" disabled={busy || f.phone.replace(/\D/g, "").length < 10 || !creditOk || (f.biz && f.bizName.trim().length < 2)}>{busy ? <span className="spinner" /> : <Icon name="check" size={16} />} Create account</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setOpen(false); setErr(null); }}>Close</button>
          </div>
        </form>
      )}

      {recent.length > 0 && (
        <details className="mt">
          <summary className="small muted">Recently added by staff ({recent.length})</summary>
          <div className="table-wrap mt">
            <table>
              <thead><tr><th>Customer</th><th>Added</th><th>By</th><th>Signed in</th></tr></thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/admin/users/${r.id}`}>{r.name ?? r.phone}</Link>{r.name && <><br /><span className="small muted">{r.phone}</span></>}</td>
                    <td className="nowrap">{r.createdAt.slice(0, 10)}</td>
                    <td>{r.staff ?? "—"}</td>
                    <td>{r.signedIn ? <span className="badge ok">Yes</span> : <span className="badge">Not yet</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
