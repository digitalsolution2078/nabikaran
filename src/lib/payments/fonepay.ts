import { createHmac, timingSafeEqual } from "node:crypto";
import type { InitiateInput, InitiateResult, LookupContext, LookupResult, PaymentGateway } from "./types";

/**
 * Checkout by Fonepay (web checkout).
 *
 *   Checkout: the browser is sent (GET) to {checkoutUrl} with
 *     PID (merchant code), MD=P, PRN (our order reference), AMT, CRN=NPR,
 *     DT (MM/DD/YYYY), R1, R2 (remarks), RU (our return URL) and
 *     DV = HMAC-SHA512(secretKey, "PID,MD,PRN,AMT,CRN,DT,R1,R2,RU") in hex.
 *
 *   Return: Fonepay redirects to RU with PRN, PID, PS, RC, UID (Fonepay
 *     transaction id), BC, INI, P_AMT, R_AMT and DV = HMAC-SHA512(secretKey,
 *     "PRN,PID,PS,RC,UID,BC,INI,P_AMT,R_AMT"). These values are untrusted.
 *
 *   Verification: GET {verifyUrl}?PRN&PID&BID&AMT&UID&DV with
 *     DV = HMAC-SHA512(secretKey, "PID,AMT,PRN,BID,UID") → XML with
 *     <success>true</success> and <response_code>successful</response_code>.
 *
 * Credits are issued only after the server-to-server verification says the
 * payment succeeded for our PRN and amount (services/payments.ts). The UID
 * from the return redirect is needed for that call, so it is kept with the
 * order and re-used by the reconciler.
 */
export interface FonepayCheckoutConfig {
  merchantCode: string;
  secretKey: string;
  checkoutUrl: string;
  verifyUrl: string;
  appUrl: string;
  fetchImpl?: typeof fetch;
}

export const fonepayHmac = (secret: string, parts: (string | number)[]) => createHmac("sha512", secret).update(parts.join(",")).digest("hex");
/** Fonepay amounts are rupees; ours are whole rupees in paisa. */
const rupees = (paisa: number) => (paisa % 100 === 0 ? String(paisa / 100) : (paisa / 100).toFixed(2));
/** Remarks: plain letters, digits and spaces. */
const remark = (s: string, max: number) => s.replace(/[^A-Za-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, max) || "Nabikaran";
/** MM/DD/YYYY in Nepal time. */
export function fonepayDate(d: Date): string {
  const k = new Date(d.getTime() + 345 * 60_000);
  return `${String(k.getUTCMonth() + 1).padStart(2, "0")}/${String(k.getUTCDate()).padStart(2, "0")}/${k.getUTCFullYear()}`;
}

/** The return redirect's query, as Fonepay sends it. */
export interface FonepayReturn {
  PRN: string;
  PID: string;
  PS: string;
  RC: string;
  UID: string;
  BC: string;
  INI: string;
  P_AMT: string;
  R_AMT: string;
  DV: string;
}

const RETURN_KEYS = ["PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT", "DV"] as const;

export class FonepayCheckoutGateway implements PaymentGateway {
  readonly name = "fonepay" as const;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: FonepayCheckoutConfig) {
    if (!cfg.merchantCode || !cfg.secretKey) throw new Error("Fonepay merchant code / secret key missing");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  get returnUrl() {
    return `${this.cfg.appUrl.replace(/\/$/, "")}/api/payments/fonepay/return`;
  }

  /** The signed checkout URL for an order. */
  checkoutUrl(o: { orderReference: string; amountPaisa: number; description: string }, now = new Date()): string {
    const p = {
      PID: this.cfg.merchantCode,
      MD: "P",
      PRN: o.orderReference,
      AMT: rupees(o.amountPaisa),
      CRN: "NPR",
      DT: fonepayDate(now),
      R1: remark(o.description, 160),
      R2: "Nabikaran",
      RU: this.returnUrl,
    };
    const u = new URL(this.cfg.checkoutUrl);
    for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
    u.searchParams.set("DV", fonepayHmac(this.cfg.secretKey, [p.PID, p.MD, p.PRN, p.AMT, p.CRN, p.DT, p.R1, p.R2, p.RU]));
    return u.toString();
  }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    return { gatewayRef: input.orderReference, paymentUrl: this.checkoutUrl(input) };
  }

  /** Read the return redirect. Untrusted: used only to find the order and the UID to verify. */
  static parseReturn(params: URLSearchParams): Partial<FonepayReturn> {
    const out: Partial<FonepayReturn> = {};
    for (const k of RETURN_KEYS) {
      const v = params.get(k);
      if (v !== null && v.length <= 300) out[k] = v;
    }
    return out;
  }

  /** Whether the return redirect's DV matches (diagnostics; verification decides). */
  returnSignatureValid(r: Partial<FonepayReturn>): boolean {
    if (!r.DV) return false;
    const want = fonepayHmac(this.cfg.secretKey, [r.PRN ?? "", r.PID ?? "", r.PS ?? "", r.RC ?? "", r.UID ?? "", r.BC ?? "", r.INI ?? "", r.P_AMT ?? "", r.R_AMT ?? ""]);
    const a = Buffer.from(want.toLowerCase());
    const b = Buffer.from(r.DV.toLowerCase());
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async lookup(ref: string, ctx?: LookupContext): Promise<LookupResult> {
    const uid = ctx?.transactionHint;
    // Without Fonepay's UID (customer closed the browser before returning) there is nothing to verify yet.
    if (!ctx || !uid) return { gatewayRef: ref, status: "pending", amountPaisa: null, transactionId: null };
    const amt = rupees(ctx.amountPaisa);
    const bid = "";
    const u = new URL(this.cfg.verifyUrl);
    u.searchParams.set("PRN", ref);
    u.searchParams.set("PID", this.cfg.merchantCode);
    u.searchParams.set("BID", bid);
    u.searchParams.set("AMT", amt);
    u.searchParams.set("UID", uid);
    u.searchParams.set("DV", fonepayHmac(this.cfg.secretKey, [this.cfg.merchantCode, amt, ref, bid, uid]));
    let text = "";
    try {
      const res = await this.fetchImpl(u.toString(), { headers: { accept: "application/xml, application/json, text/xml" }, signal: AbortSignal.timeout(15000) });
      text = await res.text();
      if (!res.ok) return { gatewayRef: ref, status: "unknown", amountPaisa: null, transactionId: null, raw: { http: res.status, body: text.slice(0, 500) } };
    } catch (e) {
      return { gatewayRef: ref, status: "unknown", amountPaisa: null, transactionId: null, raw: { error: (e as Error).message } };
    }
    const v = parseVerification(text);
    const raw = { ...v, body: text.slice(0, 1000) };
    if (v.success === null) return { gatewayRef: ref, status: "unknown", amountPaisa: null, transactionId: null, raw };
    if (!v.success) {
      const code = (v.responseCode ?? "").toLowerCase();
      return { gatewayRef: ref, status: code.includes("cancel") ? "canceled" : code.includes("fail") ? "failed" : "pending", amountPaisa: null, transactionId: null, raw };
    }
    const amount = v.amount === null ? null : Math.round(v.amount * 100);
    return {
      gatewayRef: ref,
      // Fonepay confirms for the PRN/amount/UID we asked about; the amount it reports is checked again by the caller.
      status: "completed",
      amountPaisa: amount ?? ctx.amountPaisa,
      transactionId: v.uniqueId ?? uid,
      orderReference: v.prn ?? ref,
      raw,
    };
  }
}

/** Read Fonepay's verification answer (XML; JSON tolerated). */
export function parseVerification(text: string): { success: boolean | null; responseCode: string | null; amount: number | null; uniqueId: string | null; prn: string | null } {
  let j: Record<string, unknown> | null = null;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    j = null;
  }
  const tag = (name: string): string | null => {
    if (j && j[name] !== undefined && j[name] !== null) return String(j[name]);
    const m = text.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i"));
    return m ? m[1] : null;
  };
  const s = tag("success");
  const code = tag("response_code") ?? tag("responseCode");
  const amountText = tag("txnAmount") ?? tag("amount");
  const amount = amountText === null ? null : Number(amountText.replace(/,/g, ""));
  const success = s === null ? null : s.toLowerCase() === "true" && (code === null || code.toLowerCase() === "successful");
  return { success, responseCode: code, amount: amount === null || Number.isNaN(amount) ? null : amount, uniqueId: tag("uniqueId"), prn: tag("prn") ?? tag("PRN") };
}
