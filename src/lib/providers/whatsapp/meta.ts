import type { SendOutcome } from "../sms/types";
import type { WhatsAppProvider, WhatsAppSendInput } from "./types";

/**
 * Meta WhatsApp Cloud API.
 *   POST {graph}/{version}/{phone-number-id}/messages   Authorization: Bearer <token>
 *   { messaging_product: "whatsapp", to, type: "template",
 *     template: { name, language: { code }, components: [{ type: "body", parameters: [{ type: "text", text }] }] },
 *     biz_opaque_callback_data }
 *   200 → { messages: [{ id: "wamid..." }] }
 * Delivery/read/failed arrive later via the webhook.
 */
export interface MetaConfig {
  accessToken: string;
  apiVersion: string;
  graphBase: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// Meta error codes that are worth retrying later.
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 133004]);

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly name = "meta";
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: MetaConfig) {
    if (!cfg.accessToken) throw new Error("WHATSAPP_ACCESS_TOKEN missing");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async send(input: WhatsAppSendInput): Promise<SendOutcome> {
    if (!input.phoneNumberId) return { kind: "rejected", transient: false, reason: "WhatsApp phone number ID not configured" };
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to.replace(/^\+/, ""),
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.language },
        components: [{ type: "body", parameters: input.params.map((text) => ({ type: "text", text })) }],
      },
      biz_opaque_callback_data: input.idempotencyKey,
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.graphBase}/${this.cfg.apiVersion}/${input.phoneNumberId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
      });
    } catch (e) {
      return { kind: "unknown", reason: `network: ${(e as Error).message}` };
    }
    const text = await res.text();
    let data: { messages?: Array<{ id?: string }>; error?: { code?: number; message?: string; error_subcode?: number } } | undefined;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    const id = data?.messages?.[0]?.id;
    if (res.ok && id) return { kind: "accepted", providerMessageId: id, units: 1, raw: data };
    if (res.status >= 500) return { kind: "unknown", reason: `http ${res.status}`, raw: text.slice(0, 500) };
    const err = data?.error;
    if (err) {
      const transient = res.status === 429 || TRANSIENT_CODES.has(Number(err.code));
      return { kind: "rejected", transient, reason: `meta ${err.code ?? res.status}: ${err.message ?? "error"}`.slice(0, 300), raw: err };
    }
    return { kind: "unknown", reason: `unexpected response http ${res.status}`, raw: text.slice(0, 500) };
  }
}
