import { createHmac } from "node:crypto";
import type { InitiateInput, InitiateResult, LookupContext, LookupResult, PaymentGateway } from "./types";

/**
 * eSewa ePay v2 (https://developer.esewa.com.np/pages/Epay).
 *
 *   Checkout is a browser form POST to {formUrl} with amount fields, our
 *   transaction_uuid, product_code, success/failure URLs and an HMAC-SHA256
 *   signature (base64) over "total_amount=…,transaction_uuid=…,product_code=…".
 *   initiate() therefore returns our own /pay/esewa/{orderId} page, which
 *   renders that form (signed on the server) and submits it.
 *
 *   Verification: GET {statusUrl}?product_code&total_amount&transaction_uuid
 *     -> { status: "COMPLETE" | "PENDING" | "FULL_REFUND" | "PARTIAL_REFUND" | "AMBIGUOUS" | "NOT_FOUND" | "CANCELED", ref_id, total_amount, transaction_uuid }
 *
 * The ?data= payload eSewa appends to the success URL is only used to find the
 * order; credits are issued only after the server-side status check.
 */
export interface EsewaConfig {
  productCode: string;
  secretKey: string;
  formUrl: string;
  statusUrl: string;
  appUrl: string;
  fetchImpl?: typeof fetch;
}

export const esewaSign = (secret: string, message: string) => createHmac("sha256", secret).update(message).digest("base64");
/** eSewa amounts are rupees; ours are whole rupees in paisa. */
const rupees = (paisa: number) => (paisa % 100 === 0 ? String(paisa / 100) : (paisa / 100).toFixed(2));

export class EsewaGateway implements PaymentGateway {
  readonly name = "esewa" as const;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: EsewaConfig) {
    if (!cfg.productCode || !cfg.secretKey) throw new Error("eSewa product code / secret key missing");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  get formUrl() {
    return this.cfg.formUrl;
  }

  /** The signed form fields for checkout (rendered by /pay/esewa/[id]). */
  formFields(o: { orderReference: string; amountPaisa: number }): Record<string, string> {
    const total = rupees(o.amountPaisa);
    const base = this.cfg.appUrl.replace(/\/$/, "");
    return {
      amount: total,
      tax_amount: "0",
      total_amount: total,
      transaction_uuid: o.orderReference,
      product_code: this.cfg.productCode,
      product_service_charge: "0",
      product_delivery_charge: "0",
      success_url: `${base}/api/payments/esewa/return`,
      failure_url: `${base}/api/payments/esewa/return?ref=${encodeURIComponent(o.orderReference)}&failed=1`,
      signed_field_names: "total_amount,transaction_uuid,product_code",
      signature: esewaSign(this.cfg.secretKey, `total_amount=${total},transaction_uuid=${o.orderReference},product_code=${this.cfg.productCode}`),
    };
  }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    return { gatewayRef: input.orderReference, paymentUrl: `${this.cfg.appUrl.replace(/\/$/, "")}/pay/esewa/${input.orderId}` };
  }

  /** Read the transaction_uuid from the success redirect's ?data= (base64 JSON). Untrusted. */
  static refFromReturnData(data: string | null): string | null {
    if (!data || data.length > 4000) return null;
    try {
      const j = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as { transaction_uuid?: unknown };
      return typeof j.transaction_uuid === "string" && /^[A-Za-z0-9-]{4,64}$/.test(j.transaction_uuid) ? j.transaction_uuid : null;
    } catch {
      return null;
    }
  }

  async lookup(ref: string, ctx?: LookupContext): Promise<LookupResult> {
    if (!ctx) return { gatewayRef: ref, status: "unknown", amountPaisa: null, transactionId: null };
    const u = new URL(this.cfg.statusUrl);
    u.searchParams.set("product_code", this.cfg.productCode);
    u.searchParams.set("total_amount", rupees(ctx.amountPaisa));
    u.searchParams.set("transaction_uuid", ref);
    let body: { status?: string; ref_id?: string | null; total_amount?: number | string; transaction_uuid?: string; code?: number; error_message?: string } = {};
    try {
      const res = await this.fetchImpl(u.toString(), { headers: { accept: "application/json" } });
      body = (await res.json().catch(() => ({}))) as typeof body;
      if (!res.ok && !body.status) return { gatewayRef: ref, status: "unknown", amountPaisa: null, transactionId: null, raw: body };
    } catch (e) {
      return { gatewayRef: ref, status: "unknown", amountPaisa: null, transactionId: null, raw: { error: (e as Error).message } };
    }
    const total = body.total_amount === undefined || body.total_amount === null ? null : Number(String(body.total_amount).replace(/,/g, ""));
    return {
      gatewayRef: ref,
      status: mapEsewaStatus(body.status),
      amountPaisa: total === null || Number.isNaN(total) ? null : Math.round(total * 100),
      transactionId: body.ref_id ?? null,
      orderReference: body.transaction_uuid ?? null,
      raw: body,
    };
  }
}

export function mapEsewaStatus(s: string | undefined): LookupResult["status"] {
  switch ((s ?? "").toUpperCase()) {
    case "COMPLETE":
      return "completed";
    case "PENDING":
    case "AMBIGUOUS":
      return "pending";
    case "FULL_REFUND":
    case "PARTIAL_REFUND":
      return "refunded";
    case "CANCELED":
      return "canceled";
    case "NOT_FOUND":
      return "initiated";
    default:
      return "unknown";
  }
}
