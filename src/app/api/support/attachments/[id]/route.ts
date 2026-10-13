import { z } from "zod";
import { NextResponse } from "next/server";
import { handle, HttpError } from "@/lib/http";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { getAttachment } from "@/lib/services/support";

type Ctx = { params: Promise<{ id: string }> };

/** Download a ticket attachment: staff, the ticket owner, or a visitor with the ticket's link token (?t=). */
export async function GET(req: Request, ctx: Ctx) {
  return handle(async () => {
    const id = z.string().uuid().parse((await ctx.params).id);
    const token = new URL(req.url).searchParams.get("t");
    const user = await getCurrentUser();
    const access = user && can(user.role, "support.manage") ? ({ staff: true } as const) : user ? { userId: user.id } : token ? { token } : null;
    if (!access) throw new HttpError(401, "Sign in required", "unauthenticated");
    const a = await getAttachment(id, access);
    if (!a) throw new HttpError(404, "Not found", "not_found");
    return new NextResponse(new Uint8Array(a.bytes), {
      headers: {
        "content-type": a.contentType,
        "content-disposition": `inline; filename="attachment.${a.contentType.split("/")[1]}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  });
}
