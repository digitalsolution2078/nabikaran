import type { ReportResult, SendOutcome, SmsProvider } from "./types";

/**
 * In-memory provider for development and tests. Behaviour can be scripted
 * per destination suffix so failure paths are exercised:
 *   number ending in 00 -> permanent rejection
 *   number ending in 11 -> transient rejection
 *   number ending in 22 -> unknown outcome (but message IS accepted; reconcile finds it)
 */
export class MockSmsProvider implements SmsProvider {
  readonly name = "mock";
  readonly sent: Array<{ to: string; text: string; idempotencyKey: string; id: string }> = [];
  private seq = 0;
  public log: (line: string) => void = () => undefined;

  async send(input: { to: string; text: string; idempotencyKey: string }): Promise<SendOutcome> {
    if (input.to.endsWith("00")) return { kind: "rejected", transient: false, reason: "mock: invalid destination" };
    if (input.to.endsWith("11")) return { kind: "rejected", transient: true, reason: "mock: provider busy" };
    const id = `mock-${++this.seq}`;
    this.sent.push({ ...input, id });
    this.log(`[mock-sms] to=${input.to} id=${id} text=${input.text}`);
    if (input.to.endsWith("22")) return { kind: "unknown", reason: "mock: timeout after send" };
    return { kind: "accepted", providerMessageId: id, units: Math.max(1, Math.ceil(input.text.length / 70)) };
  }

  async report(ids: string[]): Promise<ReportResult[]> {
    return ids.map((id) => ({ providerMessageId: id, status: this.sent.some((s) => s.id === id) ? "delivered" : "unknown" }));
  }

  async findByClientRef(idempotencyKey: string): Promise<ReportResult | null> {
    const hit = this.sent.find((s) => s.idempotencyKey === idempotencyKey);
    return hit ? { providerMessageId: hit.id, status: "delivered", units: 1 } : null;
  }
}
