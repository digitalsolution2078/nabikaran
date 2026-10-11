import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { createCouponBatch, giftCardStats, listCouponBatches } from "@/lib/services/credit-codes";

export async function GET(req: Request) {
  return handle(async () => {
    await requirePermission(req, "coupons.manage");
    const [batches, gifts] = await Promise.all([listCouponBatches(), giftCardStats()]);
    return json({ batches, gifts });
  });
}

const schema = z.object({
  name: z.string().trim().min(3).max(80),
  kind: z.enum(["single", "shared"]),
  credits: z.number().int().min(1).max(100000),
  count: z.number().int().min(1).max(5000).optional(),
  maxRedemptions: z.number().int().min(1).max(1000000).optional(),
  expiresAt: z.string().max(40).nullable().optional(),
  code: z.string().max(24).nullable().optional(),
});

/** Create a batch. The response carries the codes once (download the CSV later from the batch). */
export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "coupons.manage");
    const body = await parseBody(req, schema);
    return json(await createCouponBatch(admin, body), { status: 201 });
  });
}
