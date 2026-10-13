import { HttpError, handle, requirePermission } from "@/lib/http";
import { presetRange, revenueCsv, revenueReport, validRange } from "@/lib/services/revenue";

/** CSV export of the revenue dashboard for a range (?from&to or ?preset). */
export async function GET(req: Request) {
  return handle(async () => {
    await requirePermission(req, "revenue.view");
    const u = new URL(req.url);
    const range = u.searchParams.get("from") ? validRange(u.searchParams.get("from"), u.searchParams.get("to")) : presetRange(u.searchParams.get("preset") ?? "30d");
    if (!range) throw new HttpError(400, "Invalid date range (YYYY-MM-DD, at most one year)", "invalid_range");
    const csv = revenueCsv(await revenueReport(range));
    return new Response(csv, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="nabikaran-revenue-${range.from}-to-${range.to}.csv"`, "cache-control": "no-store" },
    });
  });
}
