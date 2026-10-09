import type { InitiateInput, InitiateResult, LookupResult, PaymentGateway } from "./types";

/**
 * Khalti KPG-2 (https://docs.khalti.com/khalti-epayment/).
 *
 *   POST {base}/api/v2/epayment/initiate/   Authorization: key <secret>
 *        { return_url, website_url, amount(paisa), purchase_order_id, purchase_order_name, customer_info? }
 *        -> { pidx, payment_url, expires_at }
 *   POST {base}/api/v2/epayment/lookup/     { pidx }
 *        -> { pidx, total_amount, status: "Completed"|"Pending"|"Initiated"|"Expired"|"User canceled"|"Refunded"|..., transaction_id, fee, refunded }
 *
 * The return-URL query string (pidx, status, transaction_id, amount, purchase_order_id)
 * is NEVER trusted for crediting; only lookup() is.
 */
export class KhaltiGateway implements PaymentGateway {
  readonly name = "khalti" as const;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: { secretKey: string; baseUrl: string; fetchImpl?: typeof fetch }) {
    if (!cfg.secretKey) throw new Error("KHALTI_SECRET_KEY missing");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private headers() {
    return { authorization: `key ${this.cfg.secretKey}`, "content-type": "application/json", accept: "application/json" };
  }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/api/v2/epayment/initiate/`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        return_url: input.returnUrl,
        website_url: input.websiteUrl,
        amount: input.amountPaisa,
        purchase_order_id: input.orderReference,
        purchase_order_name: input.description,
        customer_info: input.customer?.phone ? { phone: input.customer.phone.replace(/^\+977/, ""), name: input.customer.name ?? "Nabikaran user" } : undefined,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { pidx?: string; payment_url?: string; expires_at?: string; detail?: string };
    if (!res.ok || !body.pidx || !body.payment_url) {
      throw new Error(`Khalti initiate failed (${res.status}): ${body.detail ?? JSON.stringify(body)}`);
    }
    return { gatewayRef: body.pidx, paymentUrl: body.payment_url, expiresAt: body.expires_at, raw: body };
  }

  async lookup(pidx: string): Promise<LookupResult> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/api/v2/epayment/lookup/`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ pidx }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      pidx?: string;
      total_amount?: number;
      status?: string;
      transaction_id?: string | null;
      refunded?: boolean;
      purchase_order_id?: string;
    };
    if (!res.ok) return { gatewayRef: pidx, status: "unknown", amountPaisa: null, transactionId: null, raw: body };
    return {
      gatewayRef: body.pidx ?? pidx,
      status: mapKhaltiStatus(body.status, body.refunded),
      amountPaisa: typeof body.total_amount === "number" ? body.total_amount : null,
      transactionId: body.transaction_id ?? null,
      orderReference: body.purchase_order_id ?? null,
      raw: body,
    };
  }
}

export function mapKhaltiStatus(status: string | undefined, refunded?: boolean): LookupResult["status"] {
  if (refunded) return "refunded";
  switch ((status ?? "").toLowerCase()) {
    case "completed":
      return "completed";
    case "pending":
      return "pending";
    case "initiated":
      return "initiated";
    case "expired":
      return "expired";
    case "user canceled":
    case "canceled":
    case "cancelled":
      return "canceled";
    case "refunded":
    case "partially refunded":
      return "refunded";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}
