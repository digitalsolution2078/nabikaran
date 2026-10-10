import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { getSetting } from "@/lib/services/settings";
import { getDb } from "@/lib/db";
import { fonepayEnabled } from "@/lib/providers/payments/fonepay";
import { SettingsEditor } from "@/components/admin/SettingsEditor";
import { StatusBadge } from "@/components/StatusBadge";
import { GrowthSettings } from "@/components/admin/GrowthSettings";
import { referralReport } from "@/lib/services/referrals";

export const dynamic = "force-dynamic";

export default async function AdminSettings() {
  const me = await getCurrentUser();
  if (!can(me?.role, "settings.manage")) redirect("/admin");
  const [topup, qr, signin, referral, pin, report, admins] = await Promise.all([
    getSetting("topup"),
    getSetting("manual_qr"),
    getSetting("signin"),
    getSetting("referral"),
    getSetting("pin"),
    referralReport(),
    getDb().query<{ id: string; phone_e164: string; display_name: string | null; role: string }>("select id, phone_e164, display_name, role from users where role <> 'user' order by role desc, created_at"),
  ]);
  return (
    <div className="stack">
      <SettingsEditor topup={topup} qr={qr} signin={signin} dynamicQr={fonepayEnabled()} />
      <GrowthSettings referral={referral} pin={pin} />
      <section className="card">
        <h2>Referral results</h2>
        <div className="grid grid-3">
          <div className="stat"><div className="label">Invited sign-ups</div><div className="value">{report.totals.invited}</div><div className="sub">{report.totals.pending} waiting for a top-up</div></div>
          <div className="stat"><div className="label">Rewarded</div><div className="value">{report.totals.rewarded + report.totals.capped}</div><div className="sub">{report.totals.capped} over the inviter cap</div></div>
          <div className="stat"><div className="label">Bonus credits paid</div><div className="value">{report.totals.creditsPaid}</div><div className="sub">both sides, NPR {report.totals.creditsPaid}</div></div>
        </div>
        {report.top.length > 0 && (
          <div className="table-wrap mt">
            <table>
              <thead><tr><th>Top inviters</th><th className="num">Invited</th><th className="num">Rewarded</th><th className="num">Credits earned</th></tr></thead>
              <tbody>{report.top.map((x) => <tr key={x.userId}><td><Link href={`/admin/users/${x.userId}`}>{x.name ?? x.phone}</Link></td><td className="num">{x.invited}</td><td className="num">{x.rewarded}</td><td className="num">{x.credits}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <h2>Administrators</h2>
        <div className="list">
          {admins.rows.map((a) => (
            <div className="list-item" key={a.id}>
              <span className="grow"><Link href={`/admin/users/${a.id}`}><strong>{a.display_name ?? a.phone_e164}</strong></Link><br /><span className="small muted">{a.phone_e164}</span></span>
              <StatusBadge status={a.role} />
            </div>
          ))}
        </div>
        <p className="hint mt mb-0">To add an admin: open the user from <Link href="/admin/users">Users</Link> and change their role. The person must have signed in once with OTP.</p>
      </section>
    </div>
  );
}
