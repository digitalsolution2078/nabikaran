import { handle, json, limit, requireUser } from "@/lib/http";
import { revokeAllSessions } from "@/lib/auth/session";
import { audit } from "@/lib/core/audit";
import { getDb } from "@/lib/db";

/** Log out every other phone and browser; this one gets a fresh session. */
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    await limit(`user:${user.id}`, "sessions:revoke", 10, 3600);
    await revokeAllSessions(user.id, { keepCurrent: true });
    await audit(getDb(), { userId: user.id, via: "web", scopes: [], locale: user.locale }, "auth.logout_all", { type: "user", id: user.id }, {});
    return json({ ok: true });
  });
}
