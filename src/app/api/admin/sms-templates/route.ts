import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { saveSmsTemplate } from "@/lib/services/admin-console";

export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "sms.manage");
    const b = await parseBody(req, z.object({ locale: z.enum(["en-NP", "ne-NP"]), category: z.enum(["default", "today"]), body: z.string().min(10).max(320) }));
    return json(await saveSmsTemplate(admin.id, b.locale, b.category, b.body));
  });
}
