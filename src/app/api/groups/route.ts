import { handle, json, parseBody, requirePrincipal, limit } from "@/lib/http";
import { createGroup, groupInputSchema, listGroups } from "@/lib/services/groups";

export async function GET(req: Request) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    return json({ groups: await listGroups(principal.userId) });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    await limit(`user:${principal.userId}`, "group:write", 30, 60);
    const body = await parseBody(req, groupInputSchema);
    return json({ group: await createGroup(principal, body) }, { status: 201 });
  });
}
