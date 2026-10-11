import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { couponBatchCsv, setCouponBatchStatus } from "@/lib/services/credit-codes";

/** CSV of the batch's codes. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const admin = await requirePermission(req, "coupons.manage");
    const { id } = await params;
    const { filename, csv } = await couponBatchCsv(admin, id);
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } });
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const admin = await requirePermission(req, "coupons.manage");
    const { id } = await params;
    const { status } = await parseBody(req, z.object({ status: z.enum(["active", "disabled"]) }));
    await setCouponBatchStatus(admin, id, status);
    return json({ ok: true });
  });
}
