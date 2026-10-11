/**
 * Role-based access control. Roles live in users.role and are only changed by
 * a Super Admin (or the one-time database bootstrap). Checks are enforced in
 * API routes and server components; the UI only hides what the server denies.
 */
export type Role = "user" | "admin" | "super_admin" | "finance" | "support" | "content" | "auditor" | "counter";
export const STAFF_ROLES = ["super_admin", "admin", "finance", "support", "content", "auditor", "counter"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  user: "Customer",
  super_admin: "Super admin",
  admin: "Operations admin",
  finance: "Finance reviewer",
  support: "Support admin",
  content: "Template / content manager",
  auditor: "Read-only auditor",
  counter: "Counter staff (cash top-ups only)",
};

export type Permission =
  | "admin.view"              // dashboards, users, wallets, message logs, audit (read-only)
  | "topups.decide"           // approve / reject manual QR top-ups
  | "adjustments.request"     // request a credit adjustment (two-person rule)
  | "adjustments.approve"     // approve another admin's adjustment request
  | "adjustments.direct"      // apply a credit/debit immediately (single person)
  | "templates.manage"        // document template library + message template wording
  | "sms.manage"              // channel pricing (SMS + WhatsApp)
  | "whatsapp.manage"         // WhatsApp provider settings and template mapping
  | "settings.manage"         // top-up limits, QR destination, sign-in fee
  | "roles.manage"            // assign staff roles
  | "notes.write"             // support notes on a customer
  | "oauth.manage"            // MCP client kill-switch
  | "customers.export"        // download the full customer list (personal data)
  | "plans.grant"             // give, extend or revoke Pro for a customer
  | "counter.topup"           // credit a customer's wallet for cash / payment taken in person
  | "coupons.manage";         // create, download and disable coupon codes

const MATRIX: Record<Role, readonly Permission[]> = {
  user: [],
  auditor: ["admin.view"],
  counter: ["counter.topup"],
  content: ["admin.view", "templates.manage"],
  support: ["admin.view", "notes.write", "adjustments.request"],
  finance: ["admin.view", "topups.decide", "adjustments.request", "adjustments.approve", "counter.topup"],
  admin: ["admin.view", "topups.decide", "adjustments.request", "adjustments.approve", "templates.manage", "notes.write", "oauth.manage", "counter.topup", "coupons.manage"],
  super_admin: [
    "admin.view", "topups.decide", "adjustments.request", "adjustments.approve", "adjustments.direct",
    "templates.manage", "sms.manage", "whatsapp.manage", "settings.manage", "roles.manage", "notes.write", "oauth.manage",
    "customers.export", "plans.grant", "counter.topup", "coupons.manage",
  ],
};

/** Any staff role may open /admin; what they can do there is decided by `can`. */
export function isAdminRole(role: string | null | undefined): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role ?? "");
}

export function can(role: string | null | undefined, permission: Permission): boolean {
  return (MATRIX[(role ?? "user") as Role] ?? []).includes(permission);
}

export function permissionsOf(role: string | null | undefined): readonly Permission[] {
  return MATRIX[(role ?? "user") as Role] ?? [];
}
