/**
 * Payment gateway contract (PRD §9). The server creates an immutable order,
 * initiates checkout, and after the customer returns performs an independent
 * server-to-server lookup. Credits are issued ONLY when lookup reports a
 * completed payment whose amount and order reference match our record.
 */
export interface InitiateInput {
  orderId: string;
  orderReference: string;
  amountPaisa: number;
  description: string;
  returnUrl: string;
  websiteUrl: string;
  customer?: { phone?: string; name?: string };
}

export interface InitiateResult {
  gatewayRef: string; // Khalti pidx
  paymentUrl: string;
  expiresAt?: string;
  raw?: unknown;
}

export type LookupStatus = "completed" | "pending" | "initiated" | "expired" | "canceled" | "refunded" | "failed" | "unknown";

export interface LookupResult {
  gatewayRef: string;
  status: LookupStatus;
  amountPaisa: number | null;
  transactionId: string | null;
  orderReference?: string | null;
  raw?: unknown;
}

export interface PaymentGateway {
  readonly name: "khalti" | "esewa" | "mock";
  initiate(input: InitiateInput): Promise<InitiateResult>;
  lookup(gatewayRef: string): Promise<LookupResult>;
}
