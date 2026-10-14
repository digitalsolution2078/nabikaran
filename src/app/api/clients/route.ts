import { z } from "zod";
import { handle, json, parseBody, requireUser } from "@/lib/http";
import { clientInputSchema, createClient, listClients } from "@/lib/services/clients";

/** Business accounts: the signed-in customer's clients. */
export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    const url = new URL(req.url);
    return json({ clients: await listClients(user.id, { q: url.searchParams.get("q") ?? "", archived: url.searchParams.get("archived") === "1" }) });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    const body = await parseBody(req, clientInputSchema.extend({ consent: z.boolean() }));
    return json({ client: await createClient(user.id, body) }, { status: 201 });
  });
}
