import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { isAdminRole, can } from "@/lib/auth/rbac";
import { AdminTabs } from "@/components/admin/AdminTabs";

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
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Admin</h1>
          <p>Signed in as {user.displayName ?? user.phoneE164} · <span className="badge info">{user.role.replace("_", " ")}</span></p>
        </div>
      </div>
      <AdminTabs superAdmin={can(user.role, "settings.manage")} />
      {children}
    </div>
  );
}
