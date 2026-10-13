import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { presetRange, revenueReport, validRange } from "@/lib/services/revenue";
import { ChannelBadge } from "@/components/ChannelBadge";

export const dynamic = "force-dynamic";
export const metadata = { title: "Revenue" };

const PRESETS: [string, string][] = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["month", "This month"], ["lastmonth", "Last month"], ["90d", "90 days"]];
const npr = (n: number) => `NPR ${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const cr = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

export default async function AdminRevenue({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdminPage("revenue.view");
  const sp = await searchParams;
  const custom = sp.from ? validRange(sp.from, sp.to) : null;
  const preset = custom ? null : PRESETS.some(([k]) => k === sp.preset) ? sp.preset! : "30d";
  const range = custom ?? presetRange(preset!);
  const r = await revenueReport(range);
  const max = Math.max(1, ...r.daily.map((d) => d.npr));
  const used = r.usage.reduce((n, u) => n + u.credits, 0);
  const csvHref = `/api/admin/revenue?${custom ? `from=${range.from}&to=${range.to}` : `preset=${preset}`}`;
  return (
    <div className="stack">
      <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {PRESETS.map(([k, label]) => <Link key={k} href={`/admin/revenue?preset=${k}`} className="chip" aria-pressed={!custom && preset === k}>{label}</Link>)}
        </div>
        <form className="row" action="/admin/revenue" style={{ gap: 6 }}>
          <input type="date" name="from" defaultValue={range.from} aria-label="From" style={{ width: "auto" }} />
          <input type="date" name="to" defaultValue={range.to} aria-label="To" style={{ width: "auto" }} />
          <button className="btn btn-secondary btn-sm">Apply</button>
          <a className="btn btn-ghost btn-sm" href={csvHref}>Download CSV</a>
        </form>
      </div>
      <p className="small muted mb-0">{range.from} → {range.to} (Nepal time). Money in = rupees received (QR, Fonepay, counter, Khalti, eSewa, gift-card sales) minus refunds. 1 credit = NPR 1.</p>

      <div className="stat-grid">
        <div className="stat stat-hero"><div className="label">Money in</div><div className="value">{npr(r.moneyIn.totalNpr)}</div><div className="sub">{r.moneyIn.payments} payments{r.moneyIn.refundsNpr ? ` · ${npr(r.moneyIn.refundsNpr)} refunded` : ""}</div></div>
        <div className="stat"><div className="label">Wallet top-ups</div><div className="value">{npr(r.moneyIn.walletNpr)}</div><div className="sub">Gift cards sold: {npr(r.moneyIn.giftNpr)}</div></div>
        <div className="stat"><div className="label">Credits spent on messages</div><div className="value">{cr(used)}</div><div className="sub">Sign-in SMS fees: {cr(r.signInFees)}</div></div>
        <div className="stat"><div className="label">Pro sold</div><div className="value">{r.pro.sold}</div><div className="sub">{cr(r.pro.credits)} credits · {r.pro.trials} trials · {r.pro.activePaying} paying now</div></div>
        <div className="stat"><div className="label">New customers</div><div className="value">{r.customers.newSignups}</div><div className="sub">{r.customers.paying} paid in this period</div></div>
        <div className="stat"><div className="label">Credits customers hold</div><div className="value">{cr(r.liability.creditsHeld)}</div><div className="sub">{cr(r.liability.reserved)} held for scheduled messages · {r.liability.customersWithCredit} customers</div></div>
      </div>

      <section className="card">
        <div className="card-head"><h2>Money in per day</h2><span className="small muted">Peak {npr(Math.max(0, ...r.daily.map((d) => d.npr)))} · hover a bar for the day</span></div>
        <div className="rev-chart" role="img" aria-label={`Money in per day from ${range.from} to ${range.to}`}>
          {r.daily.map((d) => (
            <div key={d.day} className="rev-col" title={`${d.day}: ${npr(d.npr)}`}>
              <span className="rev-bar" style={{ height: `${Math.max(d.npr > 0 ? 2 : 0, Math.round((d.npr / max) * 100))}%` }} />
            </div>
          ))}
        </div>
        <div className="row between small muted"><span>{range.from}</span><span>{range.to}</span></div>
      </section>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <h2>By payment method</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Method</th><th className="num">Payments</th><th className="num">NPR</th><th className="num">Share</th></tr></thead>
              <tbody>
                {r.byMethod.map((m) => (
                  <tr key={m.method}><td>{m.method}</td><td className="num">{m.count}</td><td className="num">{cr(m.npr)}</td><td className="num">{r.moneyIn.walletNpr + r.moneyIn.giftNpr > 0 ? `${Math.round((m.npr / (r.moneyIn.walletNpr + r.moneyIn.giftNpr)) * 100)}%` : "—"}</td></tr>
                ))}
                {r.byMethod.length === 0 && <tr><td colSpan={4} className="muted">No payments in this period.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <h2>Messages and credits used</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Channel</th><th className="num">Messages</th><th className="num">Credits</th></tr></thead>
              <tbody>
                {r.usage.map((u) => <tr key={u.channel}><td><ChannelBadge channel={u.channel} /></td><td className="num">{u.messages}</td><td className="num">{cr(u.credits)}</td></tr>)}
              </tbody>
            </table>
          </div>
          <h3 className="mt">Promotions given (credits)</h3>
          <dl className="kv">
            <dt>Top-up bonus</dt><dd>{cr(r.promotions.topupBonus)}</dd>
            <dt>Referral rewards</dt><dd>{cr(r.promotions.referral)}</dd>
            <dt>Coupons redeemed</dt><dd>{cr(r.promotions.coupons)}</dd>
            <dt>Pro monthly credits (net of expiry)</dt><dd>{cr(r.promotions.proCreditsNet)}</dd>
            <dt>Manual adjustments</dt><dd>{cr(r.promotions.adjustments)}</dd>
            <dt><strong>Total</strong></dt><dd><strong>{cr(r.promotions.total)}</strong></dd>
          </dl>
        </section>
      </div>
    </div>
  );
}
