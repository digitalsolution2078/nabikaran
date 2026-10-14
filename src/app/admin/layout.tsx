import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { isAdminRole, can } from "@/lib/auth/rbac";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { staffNeedsTwoFactor } from "@/lib/services/two-factor";
import { getDb } from "@/lib/db";

/** Work waiting for staff, shown as counts in the admin menu. */
async function waitingCounts(): Promise<{ support: number; topups: number }> {
  try {
    const { rows } = await getDb().query<{ support: number; topups: number }>(
      `select (select count(*) from support_tickets where status = 'open')::int as support,
              (select count(*) from manual_topup_requests where status = 'pending')::int as topups`,
    );
    return rows[0] ?? { support: 0, topups: 0 };
  } catch {
    return { support: 0, topups: 0 };
  }
}

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin" };

/**
 * Every /admin page is server-rendered behind this guard; API routes enforce
 * the same permissions independently (src/lib/http.ts requirePermission).
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/admin");
  if (!isAdminRole(user.role)) redirect("/dashboard");
  // Counter-only staff never see the admin console (customer data); they work at /counter.
  if (!can(user.role, "admin.view")) redirect(can(user.role, "counter.topup") ? "/counter" : "/dashboard");
  if (await staffNeedsTwoFactor(user)) redirect("/settings?staff2fa=1#two-factor");
  return (
    <div>
      <div className="admin-head">
        <h1>Admin</h1>
        <span className="small muted">{user.displayName ?? user.phoneE164} · <span className="badge info">{user.role.replace("_", " ")}</span></span>
      </div>
      <AdminTabs superAdmin={can(user.role, "settings.manage")} coupons={can(user.role, "coupons.manage")} counter={can(user.role, "counter.topup")} support={can(user.role, "support.manage")} revenue={can(user.role, "revenue.view")}
        counts={await waitingCounts()} />
      {children}
    </div>
  );
}
