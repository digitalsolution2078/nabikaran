import { z } from "zod";
import { handle, json, parseBody, requireUser } from "@/lib/http";
import { setBusinessName } from "@/lib/services/clients";

/** Turn business tools on (name shown in client SMS) or off (null). */
export async function PUT(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    const { businessName } = await parseBody(req, z.object({ businessName: z.string().max(40).nullable() }));
    return json({ businessName: await setBusinessName(user.id, businessName) });
  });
}
