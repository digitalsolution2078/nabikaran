import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { saveDocTemplate } from "@/lib/services/admin-console";

const schema = z.object({
  slug: z.string(),
  group_key: z.string(),
  category: z.string(),
  name_en: z.string().min(1).max(80),
  name_ne: z.string().min(1).max(80),
  sms_label: z.string(),
  description_en: z.string().max(400),
  description_ne: z.string().max(400),
  default_offsets: z.array(z.number().int()),
  popular: z.boolean(),
  active: z.boolean(),
  sort_order: z.number().int(),
});

export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "templates.manage");
    await saveDocTemplate(admin.id, await parseBody(req, schema));
    return json({ ok: true });
  });
}
