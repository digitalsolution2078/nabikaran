import { z } from "zod";
import { handle, json, parseBody, requirePermission, limit } from "@/lib/http";
import { checkSmsBalance, usageReport } from "@/lib/services/message-usage";

/** Message usage report (?days=7|30|90|365). */
export async function GET(req: Request) {
  return handle(async () => {
    await requirePermission(req, "revenue.view");
    const days = Number(new URL(req.url).searchParams.get("days") ?? 30);
    return json(await usageReport(Number.isFinite(days) ? days : 30));
  });
}

/** Check the SMS provider balance now. */
export async function POST(req: Request) {
  return handle(async () => {
    const staff = await requirePermission(req, "revenue.view");
    await limit(`user:${staff.id}`, "usage:balance", 30, 3600);
    await parseBody(req, z.object({ action: z.literal("check_balance") }));
    const check = await checkSmsBalance();
    if (!check) return json({ error: "The current SMS provider has no balance API.", code: "no_balance_api" }, { status: 400 });
    return json(check);
  });
}
