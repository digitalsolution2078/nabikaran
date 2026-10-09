import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { getSetting } from "@/lib/services/settings";
import { getDb } from "@/lib/db";
import { SettingsEditor } from "@/components/admin/SettingsEditor";
import { StatusBadge } from "@/components/StatusBadge";

export const dynamic = "force-dynamic";

export default async function AdminSettings() {
  const me = await getCurrentUser();
  if (!can(me?.role, "settings.manage")) redirect("/admin");
  const [topup, qr, admins] = await Promise.all([
    getSetting("topup"),
    getSetting("manual_qr"),
    getDb().query<{ id: string; phone_e164: string; display_name: string | null; role: string }>("select id, phone_e164, display_name, role from users where role in ('admin','super_admin') order by role desc, created_at"),
  ]);
  return (
    <div className="stack">
      <SettingsEditor topup={topup} qr={qr} />
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
