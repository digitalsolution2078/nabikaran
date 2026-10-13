import { handle, json, HttpError, limit, clientIp, requireSameOrigin } from "@/lib/http";
import { getCurrentUser } from "@/lib/auth/session";
import { attachmentFromForm, createTicket, listMyTickets } from "@/lib/services/support";

/** Signed-in customer: their tickets. */
export async function GET() {
  return handle(async () => {
    const user = await getCurrentUser();
    if (!user) throw new HttpError(401, "Sign in required", "unauthenticated");
    return json({ tickets: await listMyTickets(user.id) });
  });
}

/** Open a ticket (multipart). Signed in: linked to the account. Visitor: name + phone or email, private link returned. */
export async function POST(req: Request) {
  return handle(async () => {
    await requireSameOrigin();
    const size = Number(req.headers.get("content-length") ?? "0");
    if (size > 3.6 * 1024 * 1024) throw new HttpError(413, "The file must be 3 MB or smaller.", "attachment_too_large");
    const user = await getCurrentUser();
    const ip = clientIp(req) ?? "unknown";
    if (user) await limit(`user:${user.id}`, "support:open", 10, 3600);
    else await limit(`ip:${ip}`, "support:open-guest", 5, 3600);
    const form = await req.formData().catch(() => {
      throw new HttpError(400, "Expected form data");
    });
    // Honeypot: bots fill every field.
    if (String(form.get("website") ?? "")) return json({ ok: true, ref: "NB-0000", guestToken: null });
    const s = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" && v.trim() ? v : null;
    };
    const r = await createTicket(user?.id ?? null, {
      category: (s("category") ?? "other") as "other",
      subject: s("subject") ?? "",
      body: s("body") ?? "",
      guestName: user ? null : s("name"),
      guestPhone: user ? null : s("phone"),
      guestEmail: user ? null : s("email"),
    }, await attachmentFromForm(form));
    return json({ ok: true, id: r.id, ref: r.ref, guestToken: r.guestToken });
  });
}
