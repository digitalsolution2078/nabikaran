import { handle, json, parseBody, requireUser } from "@/lib/http";
import { previewSchedule, renewalInputSchema } from "@/lib/services/renewals";
import { getWallet } from "@/lib/services/wallet";

/** Cost preview (FR-05): exact projected credits and dates before confirmation. */
export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    const input = await parseBody(req, renewalInputSchema.pick({ label: true, calendar: true, expiryDate: true, localTime: true, offsets: true }));
    const [preview, wallet] = await Promise.all([previewSchedule(input, user.locale), getWallet(user.id)]);
    return json({ preview, wallet, sufficient: wallet.available >= preview.reservedNowCredits });
  });
}
