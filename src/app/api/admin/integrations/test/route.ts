import { z } from "zod";
import { handle, json, parseBody, requirePermission, limit, HttpError } from "@/lib/http";
import { env } from "@/lib/env";
import { getDb } from "@/lib/db";
import { getSmsProvider } from "@/lib/providers/sms";
import { getSetting } from "@/lib/services/settings";
import { auditIntegrationTest, refreshIntegrations } from "@/lib/services/integrations";

/**
 * Super admin: check a provider with the saved keys.
 *  sms       sends one test SMS to the admin's own number (uses one SMS)
 *  khalti    asks Khalti about a made-up payment: a wrong key answers 401
 *  whatsapp  reads the WhatsApp phone number from Meta with the saved token
 */
export async function POST(req: Request) {
  return handle(async () => {
    const admin = await requirePermission(req, "settings.manage");
    await limit(`user:${admin.id}`, "integration:test", 10, 3600);
    const { provider } = await parseBody(req, z.object({ provider: z.enum(["sms", "khalti", "whatsapp"]) }));
    await refreshIntegrations();
    let ok = false;
    let detail = "";
    try {
      if (provider === "sms") {
        const { rows } = await getDb().query<{ phone_e164: string }>("select phone_e164 from users where id = $1", [admin.id]);
        const out = await getSmsProvider().send({ to: rows[0].phone_e164, text: "Nabikaran: test SMS from Admin > Integrations. SMS sending works.", idempotencyKey: `admin-test:${admin.id}:${Date.now()}` });
        ok = out.kind === "accepted";
        detail = out.kind === "accepted" ? `Accepted by ${getSmsProvider().name} (id ${out.providerMessageId}). Check your phone.` : `${out.kind}: ${out.reason}`;
      } else if (provider === "khalti") {
        const k = env.khalti;
        if (!k.secretKey) throw new HttpError(400, "Khalti secret key is not set.", "not_configured");
        const res = await fetch(`${k.baseUrl}/api/v2/epayment/lookup/`, {
          method: "POST", headers: { Authorization: `key ${k.secretKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ pidx: "nabikaran-key-check" }), signal: AbortSignal.timeout(10_000),
        });
        ok = res.status !== 401 && res.status !== 403;
        detail = ok ? `Khalti accepted the key (${k.baseUrl.includes("dev.") ? "test" : "live"} environment).` : "Khalti rejected the key (401). Check that it is the live/test key for this environment.";
      } else {
        const w = env.whatsapp;
        const s = await getSetting("whatsapp");
        if (!w.accessToken || !s.phone_number_id) throw new HttpError(400, "Set the WhatsApp access token and the phone number ID first.", "not_configured");
        const res = await fetch(`${w.graphBase}/${w.apiVersion}/${s.phone_number_id}?fields=display_phone_number,verified_name`, {
          headers: { Authorization: `Bearer ${w.accessToken}` }, signal: AbortSignal.timeout(10_000),
        });
        const body = (await res.json().catch(() => ({}))) as { display_phone_number?: string; verified_name?: string; error?: { message?: string } };
        ok = res.ok;
        detail = ok ? `Connected: ${body.verified_name ?? ""} ${body.display_phone_number ?? ""}`.trim() : `Meta: ${body.error?.message ?? res.status}`;
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      detail = (e as Error).message;
    }
    await auditIntegrationTest(admin, provider, ok);
    return json({ ok, detail });
  });
}
