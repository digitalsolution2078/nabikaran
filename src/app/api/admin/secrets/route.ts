import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { ADMIN_SECRETS, setSecret } from "@/lib/services/secrets";

/** Super admin: paste (or clear) a server-only key. The value is never returned. */
export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "settings.manage");
    const { key, value } = await parseBody(req, z.object({
      key: z.enum(ADMIN_SECRETS),
      value: z.string().trim().min(10).max(300).regex(/^\S+$/, "The key must not contain spaces").nullable(),
    }));
    return json(await setSecret(admin, key, value));
  });
}
