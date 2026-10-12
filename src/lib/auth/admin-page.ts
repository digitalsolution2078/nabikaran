import { notFound, redirect } from "next/navigation";
import { getCurrentUser, type SessionUser } from "./session";
import { can, isAdminRole, type Permission } from "./rbac";

/**
 * Guard for every /admin page. The admin layout checks too, but a layout is not
 * re-run for client-side navigations and data requests, so each page must check
 * before it loads anything.
 */
export async function requireAdminPage(permission: Permission = "admin.view"): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/admin");
  if (!isAdminRole(user.role) || !can(user.role, "admin.view") || !can(user.role, permission)) notFound();
  return user;
}
