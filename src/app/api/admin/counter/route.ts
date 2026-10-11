import { z } from "zod";
import { handle, json, parseBody, requirePermission, limit } from "@/lib/http";
import { can } from "@/lib/auth/rbac";
import { COUNTER_METHODS, counterLog, counterLookup, counterSellGift, counterTopup } from "@/lib/services/counter";

/** ?phone= looks up a customer; otherwise the day's counter log (?day=YYYY-MM-DD, ?all=1 for admins). */
export async function GET(req: Request) {
  return handle(async () => {
    const staff = await requirePermission(req, "counter.topup");
    const url = new URL(req.url);
    const phone = url.searchParams.get("phone");
    if (phone) {
      await limit(`user:${staff.id}`, "counter:lookup", 300, 3600);
      return json(await counterLookup(phone));
    }
    const all = url.searchParams.get("all") === "1" && can(staff.role, "admin.view");
    return json(await counterLog({ staffId: all ? null : staff.id, day: url.searchParams.get("day") ?? undefined }));
  });
}

const base = {
  amountNpr: z.number().int().min(1).max(1000000),
  method: z.enum(COUNTER_METHODS),
  receipt: z.string().max(40).nullable().default(null),
  note: z.string().max(300).nullable().default(null),
  idempotencyKey: z.string().min(8).max(64),
};
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("topup"), phone: z.string().min(9).max(20), ...base }),
  z.object({ action: z.literal("gift"), toName: z.string().max(60).nullable().default(null), message: z.string().max(200).nullable().default(null), ...base }),
]);

export async function POST(req: Request) {
  return handle(async () => {
    const staff = await requirePermission(req, "counter.topup");
    await limit(`user:${staff.id}`, "counter:write", 120, 3600);
    const body = await parseBody(req, schema);
    if (body.action === "topup") return json(await counterTopup(staff, body), { status: 201 });
    return json(await counterSellGift(staff, body), { status: 201 });
  });
}
