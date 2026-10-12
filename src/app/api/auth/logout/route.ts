import { handle, json, requireSameOrigin } from "@/lib/http";
import { clearSessionCookie } from "@/lib/auth/session";

export async function POST() {
  return handle(async () => {
    await requireSameOrigin();
    await clearSessionCookie();
    return json({ ok: true });
  });
}
