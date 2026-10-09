import { handle, json, requireAdmin } from "@/lib/http";
import { getMetrics } from "@/lib/services/admin";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    return json(await getMetrics());
  });
}
