"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../api";
import type { CouponBatch } from "@/lib/services/credit-codes";
import type { CodesSettings } from "@/lib/services/settings";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");

export function CouponsAdmin({ batches, gifts, settings, canSettings }: {
  batches: CouponBatch[];
  gifts: { active: number; activeCredits: number; used: number; cancelled: number };
  settings: CodesSettings;
  canSettings: boolean;
}) {
  const router = useRouter();
  const [f, setF] = useState({ name: "", kind: "single" as "single" | "shared", credits: 50, count: 20, maxRedemptions: 100, expires: "", code: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [made, setMade] = useState<{ name: string; codes: string[]; id: string } | null>(null);
  const [cfg, setCfg] = useState(settings);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((o) => ({ ...o, [k]: v }));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ batch: CouponBatch; codes: string[] }>("/api/admin/coupons", {
        method: "POST",
        json: {
          name: f.name, kind: f.kind, credits: f.credits,
          ...(f.kind === "single" ? { count: f.count } : { maxRedemptions: f.maxRedemptions, code: f.code.trim() || null }),
          expiresAt: f.expires ? new Date(`${f.expires}T23:59:59+05:45`).toISOString() : null,
        },
      });
      setMade({ name: r.batch.name, codes: r.codes, id: r.batch.id });
      setMsg({ ok: true, text: `Created ${r.codes.length} code(s).` });
      router.refresh();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function toggle(b: CouponBatch) {
    if (b.status === "active" && !window.confirm(`Disable "${b.name}"? Its unused codes stop working at once.`)) return;
    await api(`/api/admin/coupons/${b.id}`, { method: "PATCH", json: { status: b.status === "active" ? "disabled" : "active" } }).catch((e) => setMsg({ ok: false, text: (e as Error).message }));
    router.refresh();
  }
  async function saveCfg() {
    try {
      await api("/api/admin/settings", { method: "POST", json: { key: "codes", value: cfg } });
      setMsg({ ok: true, text: "Gift card and counter settings saved." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <div className="stack">
      {msg && <div className={`alert ${msg.ok ? "ok" : "bad"}`} role="status">{msg.text}</div>}
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <h2>New coupon batch</h2>
          <p className="muted small">Customers redeem codes in Wallet → Redeem. Each customer can use a code once. Coupon credits are a cost to the business: keep amounts small and set an expiry.</p>
          <form onSubmit={create}>
            <div className="field"><label htmlFor="cb-name">Name (for your records)</label><input id="cb-name" value={f.name} maxLength={80} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Dashain 2083 flyers" required /></div>
            <div className="field">
              <span className="label">Type</span>
              <label className="row small"><input type="radio" checked={f.kind === "single"} onChange={() => set("kind", "single")} /> Single-use codes (one per person: print, SMS or hand out)</label>
              <label className="row small"><input type="radio" checked={f.kind === "shared"} onChange={() => set("kind", "shared")} /> One shared promo code (e.g. DASHAIN50) with a total use limit</label>
            </div>
            <div className="grid grid-2">
              <div className="field"><label htmlFor="cb-credits">Credits per redemption</label><input id="cb-credits" type="number" min={1} max={100000} value={f.credits} onChange={(e) => set("credits", Number(e.target.value))} /></div>
              {f.kind === "single" ? (
                <div className="field"><label htmlFor="cb-count">How many codes</label><input id="cb-count" type="number" min={1} max={5000} value={f.count} onChange={(e) => set("count", Number(e.target.value))} /></div>
              ) : (
                <div className="field"><label htmlFor="cb-max">Total uses allowed</label><input id="cb-max" type="number" min={1} value={f.maxRedemptions} onChange={(e) => set("maxRedemptions", Number(e.target.value))} /></div>
              )}
              {f.kind === "shared" && <div className="field"><label htmlFor="cb-code">Promo code (optional)</label><input id="cb-code" className="mono" value={f.code} maxLength={20} onChange={(e) => set("code", e.target.value.toUpperCase())} placeholder="Generated if empty" /></div>}
              <div className="field"><label htmlFor="cb-exp">Expires (optional)</label><input id="cb-exp" type="date" value={f.expires} onChange={(e) => set("expires", e.target.value)} /></div>
            </div>
            <p className="hint">Total cost if every code is used: <strong>{(f.credits * (f.kind === "single" ? f.count : f.maxRedemptions)).toLocaleString()} credits</strong>.</p>
            <button className="btn btn-primary" disabled={busy || f.name.trim().length < 3}>{busy ? <span className="spinner" /> : null} Create codes</button>
          </form>
          {made && (
            <div className="alert ok mt" style={{ display: "block" }}>
              <strong>{made.name}</strong>: {made.codes.length} code(s).{" "}
              <a href={`/api/admin/coupons/${made.id}`}>Download CSV</a>
              <pre className="mono small" style={{ maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap", marginTop: 8 }}>{made.codes.slice(0, 50).join("\n")}{made.codes.length > 50 ? `\n… ${made.codes.length - 50} more in the CSV` : ""}</pre>
            </div>
          )}
        </section>
        <div className="stack">
          <section className="card">
            <h2>Gift cards</h2>
            <p className="muted small">Bought by customers with a QR payment, or sold at the Counter for cash. Wallet credits can never be sent to another customer.</p>
            <div className="stat-grid">
              <div className="stat"><div className="label">Unused (paid)</div><div className="value value-sm">{gifts.active}</div><div className="sub">{gifts.activeCredits.toLocaleString()} credits outstanding</div></div>
              <div className="stat"><div className="label">Redeemed</div><div className="value value-sm">{gifts.used}</div></div>
            </div>
          </section>
          {canSettings && (
            <section className="card">
              <h2>Gift card &amp; counter settings</h2>
              <label className="row small"><input type="checkbox" checked={cfg.gifts_enabled} onChange={(e) => setCfg({ ...cfg, gifts_enabled: e.target.checked })} /> Customers can buy gift cards</label>
              <div className="grid grid-2 mt">
                <div className="field"><label htmlFor="g-min">Gift card minimum (NPR)</label><input id="g-min" type="number" value={cfg.gift_min_npr} onChange={(e) => setCfg({ ...cfg, gift_min_npr: Number(e.target.value) })} /></div>
                <div className="field"><label htmlFor="g-max">Gift card maximum (NPR)</label><input id="g-max" type="number" value={cfg.gift_max_npr} onChange={(e) => setCfg({ ...cfg, gift_max_npr: Number(e.target.value) })} /></div>
                <div className="field"><label htmlFor="c-lim">Counter limit per staff per day (NPR, 0 = none)</label><input id="c-lim" type="number" value={cfg.counter_daily_limit_npr} onChange={(e) => setCfg({ ...cfg, counter_daily_limit_npr: Number(e.target.value) })} /><span className="hint">Super admins have no limit.</span></div>
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={saveCfg}>Save settings</button>
            </section>
          )}
        </div>
      </div>
      <section className="card">
        <h2>Coupon batches</h2>
        {batches.length === 0 ? <p className="muted mb-0">No coupons yet.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Type</th><th>Credits</th><th>Used</th><th>Issued</th><th>Expires</th><th>Status</th><th /></tr></thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td><strong>{b.name}</strong><br /><span className="small muted">{fmt(b.createdAt)}{b.createdBy ? ` · ${b.createdBy}` : ""}</span>{b.sharedCode ? <><br /><span className="mono">{b.sharedCode}</span></> : null}</td>
                    <td>{b.kind === "single" ? `${b.codeCount} single-use` : "Shared"}</td>
                    <td>{b.credits}</td>
                    <td>{b.redeemed} / {b.kind === "single" ? b.codeCount : b.maxRedemptions}</td>
                    <td>{b.creditsIssued.toLocaleString()}</td>
                    <td>{fmt(b.expiresAt)}</td>
                    <td><span className={`badge ${b.status === "active" ? "ok" : ""}`}>{b.status}</span></td>
                    <td className="row" style={{ gap: 6 }}>
                      <a className="btn btn-ghost btn-sm" href={`/api/admin/coupons/${b.id}`}>CSV</a>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggle(b)}>{b.status === "active" ? "Disable" : "Enable"}</button>
                    </td>
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
