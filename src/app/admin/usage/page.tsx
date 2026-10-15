import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/admin-page";
import { can } from "@/lib/auth/rbac";
import { env } from "@/lib/env";
import { usageReport, type Channel, type Kind } from "@/lib/services/message-usage";
import { CheckBalance, UsageSettingsForm } from "@/components/admin/UsageControls";

export const dynamic = "force-dynamic";
export const metadata = { title: "Message usage" };

const RANGES: Array<[number, string]> = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"]];
const CH: Record<Channel, string> = { sms: "SMS", whatsapp: "WhatsApp", email: "Email", push: "App notifications" };
const KIND: Record<Kind, string> = { reminder: "Reminders", sign_in: "Sign-in codes", nudge: "First-reminder nudges", low_credit: "Low-credit alerts", digest: "Pro summaries", welcome: "Welcome (staff-added)", test: "Admin tests", other: "Other" };
const n = (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const npr = (v: number) => `NPR ${n(v)}`;
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kathmandu", dateStyle: "medium", timeStyle: "short" }) + " NPT";

/** Admin → Overview → Message usage: SMS balance, and what every channel sent, earned and cost. */
export default async function AdminUsage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const me = await requireAdminPage("revenue.view");
  const { days: d } = await searchParams;
  const days = RANGES.some(([k]) => String(k) === d) ? Number(d) : 30;
  const r = await usageReport(days);
  const max = Math.max(1, ...r.daily.map((x) => x.sms + x.whatsapp + x.email + x.push));
  const low = r.balance?.available != null && r.balance.available < r.settings.lowBalance;
  const aakash = env.smsProvider === "aakash";
  const margin = r.totals.chargedCredits - r.totals.costNpr;
  const costSet = r.settings.smsCost + r.settings.whatsappCost + r.settings.emailCost > 0;

  return (
    <div className="stack">
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {RANGES.map(([k, label]) => <Link key={k} href={`/admin/usage?days=${k}`} className="chip" aria-pressed={days === k}>{label}</Link>)}
      </div>

      <div className="grid grid-4">
        <div className="stat">
          <div className="label">{aakash ? "Aakash SMS balance" : `SMS balance (${env.smsProvider})`}</div>
          <div className="value" style={low ? { color: "var(--bad)" } : undefined}>{r.balance?.available != null ? n(Math.floor(r.balance.available)) : "—"}</div>
          <div className="sub">{r.balance ? `credits · checked ${when(r.balance.checkedAt)}` : "Not checked yet"}{r.daysLeft !== null ? ` · ≈ ${r.daysLeft} days left` : ""}</div>
        </div>
        <div className="stat"><div className="label">Messages sent</div><div className="value">{n(r.totals.sent)}</div><div className="sub">all channels, last {days} days</div></div>
        <div className="stat"><div className="label">Customers charged</div><div className="value">{n(r.totals.chargedCredits)}</div><div className="sub">credits (= NPR), net of refunds</div></div>
        <div className="stat"><div className="label">Our cost · margin</div><div className="value">{costSet ? npr(r.totals.costNpr) : "—"}</div><div className="sub">{costSet ? `margin ${npr(margin)}` : "Enter your costs below to see the margin"}</div></div>
      </div>

      {low && <div className="alert bad" role="alert">SMS balance is below {n(r.settings.lowBalance)} credits. Recharge Aakash so reminders and sign-in codes keep going.</div>}
      {r.lastCheck?.error && <div className="alert warn" role="status">Last balance check failed ({when(r.lastCheck.checkedAt)}): {r.lastCheck.error}</div>}

      <section className="card">
        <div className="card-head"><h2>SMS provider balance</h2><CheckBalance /></div>
        <p className="small muted">Checked automatically every hour{aakash ? " from Aakash" : ""}. Average SMS use over the last 7 days: {n(r.avgDailySmsUnits7d)} parts a day{r.balance?.totalSent != null ? ` · ${aakash ? "Aakash" : "Provider"} total sent: ${n(r.balance.totalSent)}` : ""}.</p>
        {r.history.length > 0 && (
          <details>
            <summary className="small muted">Last {r.history.length} checks</summary>
            <div className="table-wrap mt"><table>
              <thead><tr><th>When</th><th className="num">Balance</th><th>Note</th></tr></thead>
              <tbody>{r.history.map((h, i) => <tr key={i}><td className="nowrap">{when(h.checkedAt)}</td><td className="num">{h.available != null ? n(h.available) : "—"}</td><td className="small">{h.error ?? h.provider}</td></tr>)}</tbody>
            </table></div>
          </details>
        )}
      </section>

      <section className="card">
        <h2>By channel</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Channel</th><th className="num">Sent</th><th className="num">Failed</th><th className="num">Units</th><th className="num">Charged (credits)</th><th className="num">Our cost</th><th className="num">Margin</th></tr></thead>
          <tbody>
            {r.channels.map((c) => (
              <tr key={c.channel}>
                <td><span className={`use-key use-${c.channel}`} />{CH[c.channel]}</td>
                <td className="num">{n(c.sent)}</td><td className="num">{n(c.failed)}</td><td className="num">{n(c.units)}</td>
                <td className="num">{c.channel === "push" ? "free" : n(c.chargedCredits)}</td>
                <td className="num">{c.channel === "push" ? "—" : npr(c.costNpr)}</td>
                <td className="num">{c.channel === "push" ? "—" : npr(c.chargedCredits - c.costNpr)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <p className="small muted mb-0">Units: SMS parts (a long or Nepali-script SMS uses more than one), WhatsApp and email messages, app notifications per device. Customers are charged only for reminders; sign-in codes, nudges, alerts and summaries are Nabikaran&apos;s own cost.</p>
      </section>

      <section className="card">
        <div className="card-head"><h2>Per day</h2><span className="small muted">{(["sms", "whatsapp", "email", "push"] as Channel[]).map((c) => <span key={c} style={{ marginLeft: 10 }}><span className={`use-key use-${c}`} />{CH[c]}</span>)}</span></div>
        <div className="rev-chart" role="img" aria-label={`Messages per day, last ${days} days`}>
          {r.daily.map((x) => {
            const total = x.sms + x.whatsapp + x.email + x.push;
            return (
              <div key={x.day} className="rev-col use-col" title={`${x.day}: SMS ${n(x.sms)} · WhatsApp ${n(x.whatsapp)} · Email ${n(x.email)} · App ${n(x.push)}`}>
                {(["push", "email", "whatsapp", "sms"] as Channel[]).filter((c) => x[c] > 0).map((c) => <span key={c} className={`use-seg use-${c}`} style={{ height: `${Math.max(1, (x[c] / max) * 100)}%` }} />)}
                {total === 0 && <span className="use-seg" style={{ height: 0 }} />}
              </div>
            );
          })}
        </div>
        <div className="row between small muted"><span>{r.daily[0]?.day}</span><span>{r.daily.at(-1)?.day}</span></div>
      </section>

      <section className="card">
        <h2>What was sent</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Channel</th><th>For</th><th className="num">Sent</th><th className="num">Failed</th><th className="num">Units</th></tr></thead>
          <tbody>
            {r.byKind.length === 0 && <tr><td colSpan={5} className="muted">Nothing sent in this period.</td></tr>}
            {r.byKind.map((k) => <tr key={`${k.channel}-${k.kind}`}><td>{CH[k.channel]}</td><td>{k.channel === "push" ? "Reminders and notices" : KIND[k.kind]}</td><td className="num">{n(k.sent)}</td><td className="num">{n(k.failed)}</td><td className="num">{n(k.units)}</td></tr>)}
          </tbody>
        </table></div>
        <p className="small muted mb-0">Sign-in codes, nudges, alerts and welcome messages are counted from this update on; reminders include the full history.</p>
      </section>

      <section className="card">
        <h2>Alert and costs</h2>
        {can(me.role, "settings.manage") ? <UsageSettingsForm initial={r.settings} /> : (
          <p className="small muted mb-0">Alert below {n(r.settings.lowBalance)} SMS credits ({r.settings.alert ? "on" : "off"}) · cost per SMS {npr(r.settings.smsCost)} · WhatsApp {npr(r.settings.whatsappCost)} · email {npr(r.settings.emailCost)}. Only a super admin can change these.</p>
        )}
      </section>
    </div>
  );
}
