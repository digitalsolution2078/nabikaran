import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { listDocTemplateVersions, saveDocTemplate } from "@/lib/services/admin-console";

const schema = z.object({
  slug: z.string(),
  group_key: z.string(),
  category: z.string(),
  name_en: z.string().min(1).max(80),
  name_ne: z.string().min(1).max(80),
  sms_label: z.string(),
  description_en: z.string().max(600),
  description_ne: z.string().max(600),
  default_offsets: z.array(z.number().int()),
  popular: z.boolean(),
  active: z.boolean(),
  sort_order: z.number().int(),
  published: z.boolean().default(true),
  default_channels: z.array(z.enum(["sms", "whatsapp"])).min(1).max(2).default(["sms"]),
});

/** Version history of one template (any staff can read). */
export async function GET(req: Request) {
  return handle(async () => {
    await requirePermission(req, "admin.view");
    const slug = z.string().regex(/^[a-z0-9-]{2,60}$/).parse(new URL(req.url).searchParams.get("slug"));
    return json({ versions: await listDocTemplateVersions(slug) });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "templates.manage");
    const version = await saveDocTemplate(admin.id, await parseBody(req, schema));
    return json({ ok: true, version });
  });
}
