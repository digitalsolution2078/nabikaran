import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { saveWaTemplate, saveWhatsappSettings } from "@/lib/services/whatsapp-admin";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("settings"), value: z.unknown() }),
  z.object({
    action: z.literal("template"),
    locale: z.enum(["en-NP", "ne-NP"]),
    category: z.enum(["default", "today"]),
    meta_name: z.string().trim().min(1).max(512),
    meta_language: z.string().trim().min(2).max(10),
    body_preview: z.string().trim().min(5).max(1024),
  }),
]);

/** WhatsApp provider settings and template mapping (Super Admin; tokens never accepted here). */
export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "whatsapp.manage");
    const body = await parseBody(req, schema);
    if (body.action === "settings") return json({ ok: true, value: await saveWhatsappSettings(admin.id, body.value) });
    const { action: _a, ...t } = body;
    return json({ ok: true, version: await saveWaTemplate(admin.id, t) });
  });
}
