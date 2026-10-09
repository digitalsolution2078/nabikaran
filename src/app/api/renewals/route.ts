import { handle, json, parseBody, requireUser } from "@/lib/http";
import { createRenewal, listRenewals, renewalInputSchema } from "@/lib/services/renewals";

export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    return json({ renewals: await listRenewals(user.id) });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    const input = await parseBody(req, renewalInputSchema);
    const { renewal, summary } = await createRenewal(user.id, user.locale, input);
    return json({ renewal, summary }, { status: 201 });
  });
}
