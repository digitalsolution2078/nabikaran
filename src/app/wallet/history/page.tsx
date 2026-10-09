import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getLedger } from "@/lib/services/wallet";
import { listOrders } from "@/lib/services/payments";
import { listJobsForUser } from "@/lib/services/renewals";
import { StatusBadge } from "@/components/StatusBadge";
import { formatKathmandu } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [ledger, orders, jobs] = await Promise.all([getLedger(user.id, 200), listOrders(user.id), listJobsForUser(user.id, 200)]);
  return (
    <div>
      <h1>History</h1>
      <h2>SMS</h2>
      <table>
        <thead><tr><th>Item</th><th>Due (NPT)</th><th>Status</th></tr></thead>
        <tbody>{jobs.map((j) => <tr key={j.id}><td>{j.label}</td><td>{formatKathmandu(new Date(j.due_at_utc))}</td><td><StatusBadge status={j.status} /></td></tr>)}</tbody>
      </table>
      <h2>Wallet ledger</h2>
      <table>
        <thead><tr><th>When</th><th>Type</th><th>Reference</th><th style={{ textAlign: "right" }}>Credits</th></tr></thead>
        <tbody>{ledger.map((l) => (
          <tr key={l.id}><td>{formatKathmandu(new Date(l.createdAt))}</td><td>{l.type}</td><td className="muted">{l.referenceType} {l.referenceId?.slice(0, 8)}{l.memo ? ` · ${l.memo}` : ""}</td><td style={{ textAlign: "right" }}>{l.signedCredits > 0 ? "+" : ""}{l.signedCredits}</td></tr>
        ))}</tbody>
      </table>
      <h2>Top-up orders</h2>
      <table>
        <thead><tr><th>Reference</th><th>Amount</th><th>Credits</th><th>Status</th></tr></thead>
        <tbody>{orders.map((o) => (
          <tr key={o.id}><td>{o.order_reference}<br /><span className="muted">{formatKathmandu(new Date(o.created_at))} · {o.gateway}</span></td><td>NPR {Number(o.amount_paisa) / 100}</td><td>{String(o.credits)}</td><td><StatusBadge status={o.status} /></td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}
