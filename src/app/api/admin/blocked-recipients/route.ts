import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { blockRecipient, listBlockedRecipients, unblockRecipient } from "@/lib/services/clients";

/** Numbers that must never receive business client reminders (complaints). */
export async function GET(req: Request) {
  return handle(async () => {
    await requirePermission(req, "users.ban");
    return json({ blocked: await listBlockedRecipients() });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "users.ban");
    const body = await parseBody(req, z.object({ phone: z.string().min(7).max(20), reason: z.string().trim().max(200).nullable().optional(), action: z.enum(["block", "unblock"]).default("block") }));
    if (body.action === "unblock") {
      await unblockRecipient(admin, body.phone);
      return json({ ok: true });
    }
    return json(await blockRecipient(admin, body.phone, body.reason ?? null));
  });
}
