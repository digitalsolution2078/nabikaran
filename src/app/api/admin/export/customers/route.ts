import { handle, requirePermission, limit } from "@/lib/http";
import { exportCustomersCsv } from "@/lib/services/customer-export";
import { getDb } from "@/lib/db";

/** Super admin only: full customer list as CSV. Every download is audited. */
export async function GET(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "customers.export");
    await limit(`user:${admin.id}`, "admin:export", 10, 3600);
    const url = new URL(req.url);
    const opts = { includeStaff: url.searchParams.get("staff") === "1", status: url.searchParams.get("status") === "all" ? ("all" as const) : ("active" as const) };
    const { csv, rows } = await exportCustomersCsv(opts);
    await getDb().query(
      "insert into audit_events (actor_user_id, actor_via, action, target_type, target_id, json_detail_redacted) values ($1,'web','admin.customers_exported','export','customers',$2)",
      [admin.id, JSON.stringify({ rows, ...opts })],
    );
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="nabikaran-customers-${stamp}.csv"`,
        "cache-control": "no-store",
      },
    });
  });
}
