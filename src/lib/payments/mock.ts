import type { InitiateInput, InitiateResult, LookupResult, PaymentGateway } from "./types";

/**
 * Development/test gateway. Checkout "page" is our own /pay/mock route which
 * lets the developer choose an outcome; lookup() returns the scripted state.
 */
export class MockGateway implements PaymentGateway {
  readonly name = "mock" as const;
  readonly orders = new Map<string, { amountPaisa: number; orderReference: string; status: LookupResult["status"]; transactionId: string | null }>();
  constructor(private readonly appUrl: string) {}

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    const pidx = `mock_${input.orderId.slice(0, 8)}_${Date.now().toString(36)}`;
    this.orders.set(pidx, { amountPaisa: input.amountPaisa, orderReference: input.orderReference, status: "pending", transactionId: null });
    return { gatewayRef: pidx, paymentUrl: `${this.appUrl}/pay/mock?pidx=${encodeURIComponent(pidx)}` };
  }

  /** Scripted by the mock checkout page or by tests. */
  settle(pidx: string, status: LookupResult["status"], opts: { amountPaisa?: number } = {}) {
    const o = this.orders.get(pidx);
    if (!o) return;
    o.status = status;
    if (opts.amountPaisa !== undefined) o.amountPaisa = opts.amountPaisa;
    if (status === "completed" && !o.transactionId) o.transactionId = `mocktxn_${pidx}`;
  }

  async lookup(pidx: string): Promise<LookupResult> {
    const o = this.orders.get(pidx);
    if (!o) return { gatewayRef: pidx, status: "unknown", amountPaisa: null, transactionId: null };
    return { gatewayRef: pidx, status: o.status, amountPaisa: o.amountPaisa, transactionId: o.transactionId, orderReference: o.orderReference };
  }
}
