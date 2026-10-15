import { handle, json, parseBody, requirePermission, limit } from "@/lib/http";
import { createCustomerByStaff, recentStaffCustomers, staffCustomerSchema } from "@/lib/services/staff-customers";

/** Accounts recently added by staff. */
export async function GET(req: Request) {
  return handle(async () => {
    await requirePermission(req, "customers.create");
    return json({ customers: await recentStaffCustomers(20) });
  });
}

/** Add a customer account, optionally with paid or free credits. */
export async function POST(req: Request) {
  return handle(async () => {
    const staff = await requirePermission(req, "customers.create");
    await limit(`user:${staff.id}`, "customers:create", 60, 3600);
    const body = await parseBody(req, staffCustomerSchema);
    return json(await createCustomerByStaff(staff, body), { status: 201 });
  });
}
