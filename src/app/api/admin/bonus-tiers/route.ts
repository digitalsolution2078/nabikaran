import { handle, json, requirePermission } from "@/lib/http";
import { listBonusTiers, saveBonusTiers } from "@/lib/services/pricing";

export async function GET(req: Request) {
  return handle(async () => {
    await requirePermission(req, "admin.view");
    return json({ tiers: await listBonusTiers() });
  });
}

/** Replace the top-up bonus tiers ({ tiers: [{ minNpr, percent }] }; empty = no bonus). */
export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "sms.manage");
    const body = (await req.json().catch(() => ({}))) as { tiers?: unknown };
    return json({ tiers: await saveBonusTiers(admin.id, body.tiers ?? []) });
  });
}
