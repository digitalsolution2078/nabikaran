/**
 * Role-based access control. Roles live in users.role and are only changed by
 * a Super Admin (or the one-time database bootstrap). Checks are enforced in
 * API routes and server components; the UI only hides what the server denies.
 */
export type Role = "user" | "admin" | "super_admin";

export type Permission =
  | "admin.view"              // dashboards, users, wallets, SMS logs, audit
  | "topups.decide"           // approve / reject manual QR top-ups
  | "adjustments.request"     // request a credit adjustment (two-person rule)
  | "adjustments.approve"     // approve another admin's adjustment request
  | "adjustments.direct"      // apply a credit/debit immediately (single person)
  | "templates.manage"        // document template library
  | "sms.manage"              // SMS templates and credit pricing
  | "settings.manage"         // top-up limits, QR destination
  | "roles.manage"            // promote / demote admins
  | "oauth.manage";           // MCP client kill-switch

const MATRIX: Record<Role, readonly Permission[]> = {
  user: [],
  admin: ["admin.view", "topups.decide", "adjustments.request", "adjustments.approve", "templates.manage", "oauth.manage"],
  super_admin: [
    "admin.view", "topups.decide", "adjustments.request", "adjustments.approve", "adjustments.direct",
    "templates.manage", "sms.manage", "settings.manage", "roles.manage", "oauth.manage",
  ],
};

export function isAdminRole(role: string | null | undefined): role is "admin" | "super_admin" {
  return role === "admin" || role === "super_admin";
}

export function can(role: string | null | undefined, permission: Permission): boolean {
  return (MATRIX[(role ?? "user") as Role] ?? []).includes(permission);
}

export function permissionsOf(role: string | null | undefined): readonly Permission[] {
  return MATRIX[(role ?? "user") as Role] ?? [];
}
