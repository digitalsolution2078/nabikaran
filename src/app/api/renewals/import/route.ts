import { z } from "zod";
import { handle, json, parseBody, requirePrincipal, idempotencyKeyFrom, limit } from "@/lib/http";
import { commitImport, importRequestSchema } from "@/lib/services/bulk-import";

const bodySchema = importRequestSchema.extend({ idempotencyKey: z.string().max(64).optional().nullable() });

export async function POST(req: Request) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    await limit(`user:${principal.userId}`, "import:commit", 10, 3600);
    const { idempotencyKey, ...body } = await parseBody(req, bodySchema);
    const result = await commitImport(principal, body, { idempotencyKey: idempotencyKeyFrom(req, { idempotencyKey }) });
    return json(result, { status: result.replayed ? 200 : 201 });
  });
}
