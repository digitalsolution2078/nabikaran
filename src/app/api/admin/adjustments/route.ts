import { z } from "zod";
import { handle, json, parseBody, requireAdmin, requirePermission } from "@/lib/http";
import { approveWalletAdjustment, requestWalletAdjustment } from "@/lib/services/admin";
import { getDb } from "@/lib/db";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const { rows } = await getDb().query(
      "select id, user_id, signed_credits, reason, requested_by, approved_by, status, created_at, decided_at from wallet_adjustment_requests order by created_at desc limit 50",
    );
    return json({ requests: rows });
  });
}

const schema = z.union([
  z.object({ action: z.literal("request"), userId: z.string().uuid(), signedCredits: z.number().int(), reason: z.string().min(3).max(300) }),
  z.object({ action: z.literal("approve"), requestId: z.string().uuid() }),
]);

/** Two-person rule: the approving admin must differ from the requester (enforced in SQL as well). */
export async function POST(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const body = await parseBody(req, schema);
    // Each action needs its own permission (e.g. a read-only auditor can do neither).
    const admin = await requirePermission(req, body.action === "request" ? "adjustments.request" : "adjustments.approve");
    if (body.action === "request") {
      const id = await requestWalletAdjustment(admin.id, body.userId, body.signedCredits, body.reason);
      return json({ id, status: "pending" }, { status: 201 });
    }
    await approveWalletAdjustment(admin.id, body.requestId);
    return json({ id: body.requestId, status: "applied" });
  });
}
