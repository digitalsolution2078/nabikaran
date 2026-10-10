import { z } from "zod";
import { handle, json, parseBody, requirePermission, limit } from "@/lib/http";
import { listSeoPages, resetSeoPage, saveSeoPage, seoInputSchema } from "@/lib/services/seo";

export async function GET(req: Request) {
  return handle(async () => {
    await requirePermission(req, "admin.view");
    return json({ pages: await listSeoPages({ includeHidden: true }) });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "templates.manage");
    await limit(`user:${admin.id}`, "admin:seo", 60, 60);
    return json({ page: await saveSeoPage(admin.id, await parseBody(req, seoInputSchema)) });
  });
}

export async function DELETE(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "templates.manage");
    const { slug } = await parseBody(req, z.object({ slug: z.string().max(80) }));
    await resetSeoPage(admin.id, slug);
    return json({ ok: true });
  });
}
