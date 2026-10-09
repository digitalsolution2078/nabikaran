import { handle, json, parseBody, requirePrincipal, limit } from "@/lib/http";
import { importRequestSchema, previewImport } from "@/lib/services/bulk-import";

export async function POST(req: Request) {
  return handle(async () => {
    const { principal } = await requirePrincipal(req);
    await limit(`user:${principal.userId}`, "import:preview", 60, 3600);
    const body = await parseBody(req, importRequestSchema);
    return json({ preview: await previewImport(principal, body) });
  });
}
