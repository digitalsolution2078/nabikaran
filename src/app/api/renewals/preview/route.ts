import { z } from "zod";
import { handle, json, parseBody, requirePrincipal, limit } from "@/lib/http";
import { previewSchedule, reminderInputSchema } from "@/lib/core/reminders";

/** Cost preview (FR-05): exact projected credits, SMS text and warnings before confirmation. Side-effect free. */
export async function POST(req: Request) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    await limit(`user:${principal.userId}`, "reminder:preview", 120, 60);
    const input = await parseBody(
      req,
      reminderInputSchema.pick({ label: true, calendar: true, expiryDate: true, localTime: true, offsets: true, category: true, channels: true, repeatYearly: true }).extend({ renewalId: z.string().uuid().nullish() }),
    );
    return json({ preview: await previewSchedule(principal, input) });
  });
}
