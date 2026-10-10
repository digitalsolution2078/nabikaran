import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { ADMIN_SECRETS, setSecret } from "@/lib/services/secrets";
import { refreshIntegrations } from "@/lib/services/integrations";

/** Super admin: paste (or clear) a server-only key. The value is never returned. */
export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "settings.manage");
    const { key, value } = await parseBody(req, z.object({
      key: z.enum(ADMIN_SECRETS),
      value: z.string().trim().min(4).max(2000).regex(/^\S+$/, "The key must not contain spaces").nullable(),
    }));
    const status = await setSecret(admin, key, value);
    await refreshIntegrations(); // providers pick up the new key right away
    return json(status);
  });
}
