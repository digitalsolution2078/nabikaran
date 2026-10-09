import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listRenewals, listJobsForUser } from "@/lib/services/renewals";
import { getWallet } from "@/lib/services/wallet";
import { StatusBadge } from "@/components/StatusBadge";
import { formatKathmandu } from "@/lib/time";
import { describeOffset } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [renewals, wallet, jobs] = await Promise.all([listRenewals(user.id), getWallet(user.id), listJobsForUser(user.id, 10)]);
  const upcoming = jobs.filter((j) => ["scheduled", "awaiting_credits", "planned"].includes(j.status)).sort((a, b) => a.due_at_utc.localeCompare(b.due_at_utc)).slice(0, 5);
  return (
    <div>
      <h1>Dashboard</h1>
      <div className="grid">
        <div className="stat"><div className="n">{wallet.available}</div><div className="l">Available credits</div></div>
        <div className="stat"><div className="n">{wallet.reserved}</div><div className="l">Reserved for scheduled SMS</div></div>
        <div className="stat"><div className="n">{renewals.filter((r) => r.status === "active").length}</div><div className="l">Active renewals</div></div>
      </div>
      <div className="row" style={{ margin: "12px 0" }}>
        <Link className="btn" href="/renewals/new">Add renewal</Link>
        <Link className="btn secondary" href="/wallet">Top up</Link>
      </div>
      <h2>Next reminders</h2>
      {upcoming.length === 0 ? <p className="muted">Nothing scheduled yet.</p> : (
        <table><tbody>
          {upcoming.map((j) => (
            <tr key={j.id}>
              <td><Link href={`/renewals/${j.renewal_id}`}>{j.label}</Link><br /><span className="muted">{describeOffset(j.offset_minutes ?? 0)}</span></td>
              <td>{formatKathmandu(new Date(j.due_at_utc))}</td>
              <td><StatusBadge status={j.status} /></td>
            </tr>
          ))}
        </tbody></table>
      )}
      {jobs.some((j) => j.status === "awaiting_credits") && <p className="notice">Some reminders are waiting for credits. <Link href="/wallet">Top up</Link> and they will be scheduled automatically.</p>}
      <h2>Recent SMS</h2>
      {jobs.filter((j) => ["submitted", "delivered", "failed", "unknown"].includes(j.status)).slice(0, 5).map((j) => (
        <div key={j.id} className="row" style={{ fontSize: 14, padding: "4px 0" }}>
          <span>{j.label}</span><span className="muted">{formatKathmandu(new Date(j.due_at_utc))}</span><StatusBadge status={j.status} />
        </div>
      ))}
      <p><Link href="/wallet/history">Full SMS and wallet history →</Link></p>
    </div>
  );
}
