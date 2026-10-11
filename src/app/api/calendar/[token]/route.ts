import { clientIp, limit } from "@/lib/http";
import { feedForToken } from "@/lib/services/calendar";

export const dynamic = "force-dynamic";

/**
 * Pro calendar feed (read-only .ics). The secret token in the path is the only
 * credential, so the link is never logged and unknown links get a plain 404.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = raw.replace(/\.ics$/i, "");
  try {
    await limit(`ip:${clientIp(req) ?? "unknown"}`, "calendar:feed", 120, 3600);
  } catch {
    return new Response("Too many requests", { status: 429, headers: { "retry-after": "3600" } });
  }
  const body = await feedForToken(token).catch(() => null);
  if (body === null) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="nabikaran.ics"',
      "cache-control": "private, max-age=900",
      "x-robots-tag": "noindex",
    },
  });
}
