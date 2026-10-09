import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { webPrincipal } from "@/lib/core/principal";
import { listReminders } from "@/lib/core/reminders";
import { StatusBadge } from "@/components/StatusBadge";

export const dynamic = "force-dynamic";

export default async function RenewalsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { reminders } = await listReminders(webPrincipal(user), { status: "all", limit: 50 });
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Renewals</h1>
        <Link className="btn" href="/renewals/new">Add renewal</Link>
      </div>
      {reminders.length === 0 ? <p className="muted">No renewals yet.</p> : (
        <table>
          <thead><tr><th>Item</th><th>Expires (NPT)</th><th>Status</th></tr></thead>
          <tbody>
            {reminders.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/renewals/${r.id}`}>{r.label}</Link><br /><span className="muted">{r.category}{r.familyMemberLabel ? ` · ${r.familyMemberLabel}` : ""}</span></td>
                <td>{r.expiry.local}<br /><span className="muted">{r.expiry.bs?.display ?? ""}</span></td>
                <td><StatusBadge status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
