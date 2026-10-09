import { z } from "zod";
import { handle, json, parseBody, requirePermission } from "@/lib/http";
import { createPricingVersion } from "@/lib/services/admin";
import { getDb } from "@/lib/db";

export async function GET(req: Request) {
  return handle(async () => {
    await requirePermission(req, "sms.manage");
    const { rows } = await getDb().query("select id, channel, effective_at, credits_per_billable_unit, created_by, created_at from pricing_versions order by effective_at desc limit 40");
    return json({ versions: rows });
  });
}

/** Prospective price change with explicit preview: the response echoes what will apply and when. */
export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "sms.manage");
    const body = await parseBody(req, z.object({ channel: z.enum(["sms", "whatsapp"]).default("sms"), creditsPerUnit: z.number().int().positive().max(1000), effectiveAt: z.string().datetime().optional(), confirm: z.boolean().default(false) }));
    const effectiveAt = body.effectiveAt ? new Date(body.effectiveAt) : new Date();
    const preview = { channel: body.channel, creditsPerUnit: body.creditsPerUnit, effectiveAt: effectiveAt.toISOString(), note: "Existing reservations keep their cost snapshot; only new schedules use the new price." };
    if (!body.confirm) return json({ preview });
    const id = await createPricingVersion(admin.id, body.creditsPerUnit, effectiveAt, undefined, body.channel);
    return json({ preview, id }, { status: 201 });
  });
}
