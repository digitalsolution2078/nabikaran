import { z } from "zod";
import { handle, json, parseBody, requirePermission, limit, HttpError } from "@/lib/http";
import { getEmailProvider, textToHtml } from "@/lib/providers/email";

/** Super admin: send a test email with the saved Resend settings. */
export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "settings.manage");
    await limit(`user:${admin.id}`, "email:test", 10, 3600);
    const { to } = await parseBody(req, z.object({ to: z.string().trim().email().max(120) }));
    const provider = await getEmailProvider();
    if (!provider) throw new HttpError(400, "Email is not ready: turn it on, paste the Resend API key and set the From address.", "email_unavailable");
    const text = "This is a test email from Nabikaran. Email reminders and email sign-in are working.";
    const out = await provider.send({ to, subject: "Nabikaran test email", text, html: textToHtml(text), idempotencyKey: `test-${Date.now()}` });
    if (out.kind !== "accepted") throw new HttpError(502, out.reason, "email_send_failed");
    return json({ ok: true, id: out.providerMessageId });
  });
}
