"use client";
import { useState } from "react";
import { api } from "../api";
import { Icon } from "../Icon";

type Log = { day: string; entries: Array<{ id: string; reference: string; at: string; amountNpr: number; method: string; receipt: string | null; kind: "wallet" | "gift"; customer: string | null; staff: string }>; totals: Array<{ method: string; amountNpr: number; count: number }>; totalNpr: number };
type Customer = { id: string; phone: string; name: string | null; available: number };
type Done = { kind: "wallet" | "gift"; reference: string; amountNpr: number; credits: number; method: string; receipt: string; at: string; phone?: string; name?: string | null; balance?: number; code?: string; toName?: string };

const METHODS: Array<[string, string]> = [["cash", "Cash"], ["esewa", "eSewa"], ["khalti", "Khalti"], ["fonepay", "Fonepay / bank QR"], ["bank", "Bank transfer"], ["other", "Other"]];
const methodLabel = (m: string) => METHODS.find(([k]) => k === m)?.[1] ?? m;
const npr = (n: number) => `NPR ${n.toLocaleString("en-IN")}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kathmandu" });
const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, "").slice(0, 32);

export function CounterDesk({ initialLog, canSeeAll, gift }: { initialLog: Log; canSeeAll: boolean; gift: { enabled: boolean; min: number; max: number } }) {
  const [tab, setTab] = useState<"topup" | "gift">("topup");
  const [phone, setPhone] = useState("");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [f, setF] = useState({ amount: "", method: "cash", receipt: "", note: "", toName: "", message: "" });
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [log, setLog] = useState(initialLog);
  const [all, setAll] = useState(false);
  const amount = Math.floor(Number(f.amount) || 0);

  const refreshLog = async (everyone = all) => setLog(await api<Log>(`/api/admin/counter${everyone ? "?all=1" : ""}`));
  const reset = () => { setF({ amount: "", method: "cash", receipt: "", note: "", toName: "", message: "" }); setKey(newKey()); };

  async function find(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setCustomer(null);
    setBusy(true);
    try {
      setCustomer(await api<Customer>(`/api/admin/counter?phone=${encodeURIComponent(phone)}`));
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const what = tab === "topup" ? `Add ${npr(amount)} = ${amount} credits to ${customer?.phone}${customer?.name ? ` (${customer.name})` : ""}` : `Sell a gift card of ${npr(amount)}`;
    if (!window.confirm(`${what}, paid by ${methodLabel(f.method)}?\n\nOnly confirm after the money is in your hand or account.`)) return;
    setBusy(true);
    try {
      const common = { amountNpr: amount, method: f.method, receipt: f.receipt.trim() || null, note: f.note.trim() || null, idempotencyKey: key };
      if (tab === "topup") {
        const r = await api<{ reference: string; credits: number; customer: Customer }>("/api/admin/counter", { method: "POST", json: { action: "topup", phone: customer!.phone, ...common } });
        setDone({ kind: "wallet", reference: r.reference, amountNpr: amount, credits: r.credits, method: f.method, receipt: f.receipt.trim(), at: new Date().toISOString(), phone: r.customer.phone, name: r.customer.name, balance: r.customer.available });
        setCustomer(r.customer);
      } else {
        const r = await api<{ reference: string; credits: number; code: string }>("/api/admin/counter", { method: "POST", json: { action: "gift", toName: f.toName.trim() || null, message: f.message.trim() || null, ...common } });
        setDone({ kind: "gift", reference: r.reference, amountNpr: amount, credits: r.credits, method: f.method, receipt: f.receipt.trim(), at: new Date().toISOString(), code: r.code, toName: f.toName.trim() });
      }
      reset();
      await refreshLog();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const amountOk = tab === "gift" ? amount >= gift.min && amount <= gift.max : amount >= 1;
  return (
    <div className="stack">
      <div className="row" role="tablist" style={{ gap: 8 }}>
        <button type="button" role="tab" aria-selected={tab === "topup"} className={`btn ${tab === "topup" ? "btn-primary" : "btn-ghost"}`} onClick={() => { setTab("topup"); setDone(null); setErr(null); }}><Icon name="wallet" size={16} /> Top up a customer</button>
        {gift.enabled && <button type="button" role="tab" aria-selected={tab === "gift"} className={`btn ${tab === "gift" ? "btn-primary" : "btn-ghost"}`} onClick={() => { setTab("gift"); setDone(null); setErr(null); }}><Icon name="gift" size={16} /> Sell a gift card</button>}
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          {tab === "topup" && (
            <form className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }} onSubmit={find}>
              <div className="field mb-0 grow" style={{ minWidth: 200 }}>
                <label htmlFor="ct-phone">Customer mobile number</label>
                <input id="ct-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setCustomer(null); }} placeholder="98XXXXXXXX" />
              </div>
              <button className="btn btn-outline" disabled={busy || phone.replace(/\D/g, "").length < 10}>Find</button>
            </form>
          )}
          {tab === "topup" && customer && (
            <div className="alert info mt"><Icon name="check" /><span><strong>{customer.name ?? "Customer"}</strong> · {customer.phone}<br />Balance now: {customer.available.toLocaleString()} credits</span></div>
          )}
          {(tab === "gift" || customer) && (
            <form onSubmit={submit} className="mt">
              <div className="grid grid-2">
                <div className="field">
                  <label htmlFor="ct-amount">Amount received (NPR)</label>
                  <input id="ct-amount" type="number" inputMode="numeric" min={1} step={1} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required />
                  <span className="hint">{tab === "gift" ? `Gift card NPR ${gift.min}–${gift.max}. ` : ""}1 rupee = 1 credit.</span>
                </div>
                <div className="field">
                  <label htmlFor="ct-method">Paid by</label>
                  <select id="ct-method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                </div>
                <div className="field">
                  <label htmlFor="ct-receipt">Receipt / transaction no. (optional)</label>
                  <input id="ct-receipt" value={f.receipt} maxLength={40} onChange={(e) => setF({ ...f, receipt: e.target.value })} placeholder={f.method === "cash" ? "Bill book no." : "From the payment app"} />
                </div>
                <div className="field">
                  <label htmlFor="ct-note">Note (optional)</label>
                  <input id="ct-note" value={f.note} maxLength={300} onChange={(e) => setF({ ...f, note: e.target.value })} />
                </div>
                {tab === "gift" && <>
                  <div className="field"><label htmlFor="ct-to">For (printed on the card)</label><input id="ct-to" value={f.toName} maxLength={60} onChange={(e) => setF({ ...f, toName: e.target.value })} /></div>
                  <div className="field"><label htmlFor="ct-msg">Message (optional)</label><input id="ct-msg" value={f.message} maxLength={200} onChange={(e) => setF({ ...f, message: e.target.value })} /></div>
                </>}
              </div>
              {err && <div className="alert bad" role="alert">{err}</div>}
              <button className="btn btn-primary" disabled={busy || !amountOk}>{busy ? <span className="spinner" /> : <Icon name="check" size={16} />} {tab === "topup" ? `Add ${amount ? npr(amount) : ""} to wallet` : `Sell gift card ${amount ? npr(amount) : ""}`}</button>
            </form>
          )}
          {tab === "topup" && !customer && err && <div className="alert bad mt" role="alert">{err}</div>}
        </section>

        <section className="card print-area" aria-live="polite">
          {!done ? <p className="muted mb-0">The receipt appears here after each entry. Print it or show it to the customer.</p> : (
            <div>
              <div className="row between"><strong>Nabikaran · नवीकरण</strong><span className="small muted">{new Date(done.at).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu" })}</span></div>
              <h2 className="mt">{done.kind === "gift" ? "Gift card" : "Top-up receipt"}</h2>
              {done.kind === "gift" && done.code && (
                <div style={{ border: "2px dashed var(--brand)", borderRadius: 12, padding: 16, textAlign: "center", margin: "12px 0" }}>
                  {done.toName && <div>For {done.toName}</div>}
                  <div className="mono" style={{ fontSize: 26, fontWeight: 800, letterSpacing: 2 }}>{done.code}</div>
                  <div>{done.credits} credits</div>
                  <div className="small muted">Redeem at nabikaran.org → Wallet → Redeem</div>
                </div>
              )}
              <dl className="kv">
                <dt>Reference</dt><dd className="mono">{done.reference}</dd>
                <dt>Amount paid</dt><dd>{npr(done.amountNpr)} ({methodLabel(done.method)})</dd>
                {done.receipt && <><dt>Receipt no.</dt><dd>{done.receipt}</dd></>}
                {done.kind === "wallet" && <><dt>Customer</dt><dd>{done.name ? `${done.name} · ` : ""}{done.phone}</dd><dt>Credits added</dt><dd>{done.credits}</dd><dt>New balance</dt><dd>{done.balance?.toLocaleString()} credits</dd></>}
              </dl>
              <p className="small muted">Credits do not expire and are not refundable as cash.</p>
              <button type="button" className="btn btn-outline btn-sm no-print" onClick={() => window.print()}>Print</button>
            </div>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Today ({log.day}) · {npr(log.totalNpr)}</h2>
          {canSeeAll && <label className="row small"><input type="checkbox" checked={all} onChange={(e) => { setAll(e.target.checked); refreshLog(e.target.checked); }} /> All staff</label>}
        </div>
        {log.totals.length > 0 && <p className="small">{log.totals.map((t) => `${methodLabel(t.method)}: ${npr(t.amountNpr)} (${t.count})`).join(" · ")}</p>}
        {log.entries.length === 0 ? <p className="muted mb-0">No counter entries yet today.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Ref</th><th>What</th><th>Customer</th><th className="num">Amount</th><th>Paid by</th><th>Receipt</th>{all && <th>Staff</th>}</tr></thead>
              <tbody>
                {log.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{time(e.at)}</td><td className="mono">{e.reference}</td><td>{e.kind === "gift" ? "Gift card" : "Top-up"}</td><td>{e.customer ?? "—"}</td>
                    <td className="num">{npr(e.amountNpr)}</td><td>{methodLabel(e.method)}</td><td>{e.receipt ?? "—"}</td>{all && <td>{e.staff}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
