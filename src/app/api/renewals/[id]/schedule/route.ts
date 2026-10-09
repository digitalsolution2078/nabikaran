import { z } from "zod";
import { handle, json, parseBody, requireUser, HttpError } from "@/lib/http";
import { getRenewal, previewSchedule, updateRenewal } from "@/lib/services/renewals";
import { getWallet } from "@/lib/services/wallet";
import { MAX_OFFSET_MINUTES } from "@/lib/scheduler";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  offsets: z.array(z.number().int().min(0).max(MAX_OFFSET_MINUTES)).min(1).max(20),
  confirm: z.boolean().default(false),
});

/**
 * Preview (confirm=false) or apply (confirm=true) a reminder schedule for an
 * existing renewal. Applying is a versioned update that cancels unsent jobs
 * from the previous cycle and reserves credits for the new plan.
 */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const user = await requireUser(req);
    const { id } = await ctx.params;
    const renewalId = z.string().uuid().parse(id);
    const body = await parseBody(req, schema);
    const existing = await getRenewal(user.id, renewalId);
    if (!existing) throw new HttpError(404, "Renewal not found");
    const r = existing.renewal;
    const base = {
      label: r.label,
      calendar: r.date_input_calendar,
      expiryDate: r.date_input_raw ?? r.expiry_at_utc.slice(0, 10),
      localTime: r.local_time,
      offsets: body.offsets,
    };
    const [preview, wallet] = await Promise.all([previewSchedule(base, user.locale), getWallet(user.id)]);
    if (!body.confirm) return json({ preview, wallet, sufficient: wallet.available >= preview.reservedNowCredits });
    const result = await updateRenewal(user.id, user.locale, renewalId, {
      ...base,
      category: r.category as never,
      notes: r.notes,
      familyMemberLabel: r.family_member_label,
    });
    return json({ preview, ...result });
  });
}
