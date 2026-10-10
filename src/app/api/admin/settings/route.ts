import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { setSetting } from "@/lib/services/settings";

export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "settings.manage");
    const { key, value } = await parseBody(req, z.object({ key: z.enum(["topup", "manual_qr", "signin", "referral", "pin", "pro", "email"]), value: z.unknown() }));
    return json({ ok: true, value: await setSetting(admin, key, value) });
  });
}
