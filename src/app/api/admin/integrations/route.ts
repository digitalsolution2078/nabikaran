import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { z } from "zod";
import { integrationStatus, saveIntegrationSettings } from "@/lib/services/integrations";

export async function GET(req: Request) {
  return handle(async () => {
    await requirePermission(req, "settings.manage");
    return json(await integrationStatus());
  });
}

/** Super admin: provider modes (SMS, Khalti, Fonepay, WhatsApp). Keys are saved through /api/admin/secrets. */
export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "settings.manage");
    const { value } = await parseBody(req, z.object({ value: z.unknown() }));
    await saveIntegrationSettings(admin, value);
    return json(await integrationStatus());
  });
}
