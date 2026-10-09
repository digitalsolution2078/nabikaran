import { handle, json } from "@/lib/http";
import { clearSessionCookie } from "@/lib/auth/session";

export async function POST() {
  return handle(async () => {
    await clearSessionCookie();
    return json({ ok: true });
  });
}
