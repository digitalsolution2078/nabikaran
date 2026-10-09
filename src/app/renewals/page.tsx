import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listRenewals } from "@/lib/services/renewals";
import { StatusBadge } from "@/components/StatusBadge";
import { formatKathmandu } from "@/lib/time";
import { adToBs, formatBs } from "@/lib/bs-date";
import { utcToKathmandu } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function RenewalsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const renewals = await listRenewals(user.id);
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Renewals</h1>
        <Link className="btn" href="/renewals/new">Add renewal</Link>
      </div>
      {renewals.length === 0 ? <p className="muted">No renewals yet.</p> : (
        <table>
          <thead><tr><th>Item</th><th>Expires (NPT)</th><th>Status</th></tr></thead>
          <tbody>
            {renewals.map((r) => {
              const exp = new Date(r.expiry_at_utc);
              let bs = "";
              try { bs = formatBs(adToBs(utcToKathmandu(exp)), "ne"); } catch { bs = ""; }
              return (
                <tr key={r.id}>
                  <td><Link href={`/renewals/${r.id}`}>{r.label}</Link><br /><span className="muted">{r.category}{r.family_member_label ? ` · ${r.family_member_label}` : ""}</span></td>
                  <td>{formatKathmandu(exp)}<br /><span className="muted">{bs}</span></td>
                  <td><StatusBadge status={r.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
