import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { listClientsForAdmin, setClientDisabled } from "@/lib/oauth/tokens";

/** Admin kill-switch for OAuth/MCP clients (docs §7). */
export async function GET(req: Request) {
  return handle(async () => {
    await requirePermission(req, "oauth.manage");
    return json({ clients: await listClientsForAdmin() });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "oauth.manage");
    const { clientId, action } = await parseBody(req, z.object({ clientId: z.string().min(1).max(64), action: z.enum(["disable", "enable"]) }));
    const found = await setClientDisabled(admin.id, clientId, action === "disable");
    return json({ ok: found, clientId, disabled: action === "disable" });
  });
}
