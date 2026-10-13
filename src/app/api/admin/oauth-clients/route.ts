import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { listClientsForAdmin, revokeAllForUserClient, setClientDisabled } from "@/lib/oauth/tokens";
import { getDb } from "@/lib/db";

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
    const { clientId, action, userId } = await parseBody(req, z.object({ clientId: z.string().min(1).max(64), action: z.enum(["disable", "enable", "disconnect_user"]), userId: z.string().uuid().optional() }));
    if (action === "disconnect_user") {
      if (!userId) return json({ ok: false, error: "user_required" }, { status: 400 });
      const n = await revokeAllForUserClient(userId, clientId, "admin_disconnect");
      await getDb().query("insert into audit_events (actor_user_id, actor_via, actor_client_id, action, target_type, target_id) values ($1,'web',$2,'oauth.user_disconnected','user',$3)", [admin.id, clientId, userId]);
      return json({ ok: true, revoked: n });
    }
    const found = await setClientDisabled(admin.id, clientId, action === "disable");
    return json({ ok: found, clientId, disabled: action === "disable" });
  });
}
