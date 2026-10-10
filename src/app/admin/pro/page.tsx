import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { getSetting } from "@/lib/services/settings";
import { secretStatus } from "@/lib/services/secrets";
import { proReport } from "@/lib/services/plans";
import { ProAdmin } from "@/components/admin/ProAdmin";

export const dynamic = "force-dynamic";

export default async function AdminPro() {
  const me = await getCurrentUser();
  if (!can(me?.role, "settings.manage")) redirect("/admin");
  const [pro, email, key, report] = await Promise.all([getSetting("pro"), getSetting("email"), secretStatus("resend_api_key"), proReport()]);
  return (
    <div className="stack">
      <section className="card">
        <h2>Pro at a glance</h2>
        <div className="grid grid-3">
          <div className="stat"><div className="label">Paid Pro (active)</div><div className="value">{report.activePaid}</div><div className="sub">{report.activeGrant} given by admin</div></div>
          <div className="stat"><div className="label">On free trial</div><div className="value">{report.activeTrial}</div><div className="sub">{report.trialsStarted} trials ever · {report.trialToPaid} bought after a trial</div></div>
          <div className="stat"><div className="label">Pro sales</div><div className="value">{report.revenueCredits}</div><div className="sub">credits (NPR) from wallet purchases</div></div>
        </div>
        {report.recent.length > 0 && (
          <div className="table-wrap mt">
            <table>
              <thead><tr><th>Customer</th><th>Plan</th><th>Ends</th></tr></thead>
              <tbody>{report.recent.map((r, i) => <tr key={`${r.userId}-${i}`}><td><Link href={`/admin/users/${r.userId}`}>{r.name ?? r.phone}</Link></td><td>{r.kind}</td><td>{r.endsAt.slice(0, 10)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
      <ProAdmin pro={pro} email={email} keyStatus={key} />
    </div>
  );
}
