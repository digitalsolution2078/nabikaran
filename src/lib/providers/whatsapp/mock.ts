import type { SendOutcome } from "../sms/types";
import type { WhatsAppProvider, WhatsAppSendInput } from "./types";

/** Development/test double. Numbers ending 00 are rejected, 11 transient, 22 unknown. */
export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly name = "mock";
  readonly sent: Array<WhatsAppSendInput & { id: string }> = [];
  private seq = 0;
  public log: (line: string) => void = () => undefined;
  async send(input: WhatsAppSendInput): Promise<SendOutcome> {
    if (input.to.endsWith("00")) return { kind: "rejected", transient: false, reason: "meta 131026: message undeliverable" };
    if (input.to.endsWith("11")) return { kind: "rejected", transient: true, reason: "meta 130429: rate limit" };
    const id = `wamid.mock-${++this.seq}`;
    this.sent.push({ ...input, id });
    this.log(`[mock-whatsapp] to=${input.to} id=${id} template=${input.templateName}/${input.language} params=${JSON.stringify(input.params)}`);
    if (input.to.endsWith("22")) return { kind: "unknown", reason: "mock: timeout after send" };
    return { kind: "accepted", providerMessageId: id, units: 1 };
  }
}
