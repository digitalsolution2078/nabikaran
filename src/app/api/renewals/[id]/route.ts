import { z } from "zod";
import { handle, json, parseBody, requireUser, HttpError } from "@/lib/http";
import { getRenewal, renewalInputSchema, setRenewalStatus, updateRenewal } from "@/lib/services/renewals";

type Ctx = { params: Promise<{ id: string }> };
const uuid = z.string().uuid();

export async function GET(req: Request, ctx: Ctx) {
  return handle(async () => {
    const user = await requireUser(req);
    const { id } = await ctx.params;
    const data = await getRenewal(user.id, uuid.parse(id));
    if (!data) throw new HttpError(404, "Renewal not found");
    return json(data);
  });
}

const patchSchema = z.union([
  z.object({ action: z.enum(["pause", "resume", "cancel"]) }),
  renewalInputSchema,
]);

/** Versioned update: a full edit starts a new cycle; action patches change status. */
export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async () => {
    const user = await requireUser(req);
    const { id } = await ctx.params;
    const renewalId = uuid.parse(id);
    const body = await parseBody(req, patchSchema);
    if ("action" in body) {
      const map = { pause: "paused", resume: "active", cancel: "cancelled" } as const;
      return json(await setRenewalStatus(user.id, renewalId, map[body.action]));
    }
    return json(await updateRenewal(user.id, user.locale, renewalId, body));
  });
}

export async function DELETE(req: Request, ctx: Ctx) {
  return handle(async () => {
    const user = await requireUser(req);
    const { id } = await ctx.params;
    return json(await setRenewalStatus(user.id, uuid.parse(id), "deleted"));
  });
}
