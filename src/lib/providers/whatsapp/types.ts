import type { SendOutcome } from "../sms/types";

export interface WhatsAppSendInput {
  /** E.164 with + */
  to: string;
  phoneNumberId: string;
  templateName: string;
  language: string;
  params: string[];
  /** Our attempt key; echoed back by Meta in status webhooks (biz_opaque_callback_data). */
  idempotencyKey: string;
}

export interface WhatsAppProvider {
  readonly name: string;
  send(input: WhatsAppSendInput): Promise<SendOutcome>;
}
