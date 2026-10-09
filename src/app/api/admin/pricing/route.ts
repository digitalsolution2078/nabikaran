import { z } from "zod";
import { handle, json, parseBody, requireAdmin } from "@/lib/http";
import { createPricingVersion } from "@/lib/services/admin";
import { getDb } from "@/lib/db";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const { rows } = await getDb().query("select id, effective_at, credits_per_billable_unit, created_by, created_at from pricing_versions order by effective_at desc limit 20");
    return json({ versions: rows });
  });
}

/** Prospective price change with explicit preview: the response echoes what will apply and when. */
export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requireAdmin(req);
    const body = await parseBody(req, z.object({ creditsPerUnit: z.number().int().positive(), effectiveAt: z.string().datetime().optional(), confirm: z.boolean().default(false) }));
    const effectiveAt = body.effectiveAt ? new Date(body.effectiveAt) : new Date();
    const preview = { creditsPerUnit: body.creditsPerUnit, effectiveAt: effectiveAt.toISOString(), note: "Existing reservations keep their cost snapshot; only new schedules use the new price." };
    if (!body.confirm) return json({ preview });
    const id = await createPricingVersion(admin.id, body.creditsPerUnit, effectiveAt);
    return json({ preview, id }, { status: 201 });
  });
}
