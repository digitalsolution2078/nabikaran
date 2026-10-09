import { z } from "zod";
import { handle, json, parseBody, requireUser } from "@/lib/http";
import { listConnections, revokeAllForUserClient } from "@/lib/oauth/tokens";

/** Connected apps (OAuth clients holding live tokens for this user). */
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    return json({ connections: await listConnections(user.id) });
  });
}

/** Disconnect one client (revokes all of its tokens for this user). */
export async function DELETE(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    const { clientId } = await parseBody(req, z.object({ clientId: z.string().min(1).max(64) }));
    const revoked = await revokeAllForUserClient(user.id, clientId, "user_disconnected");
    return json({ ok: true, revoked });
  });
}
