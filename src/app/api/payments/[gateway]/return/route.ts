import { NextResponse } from "next/server";
import { z } from "zod";
import { confirmPaymentByRef } from "@/lib/services/payments";
import { env } from "@/lib/env";
import { EsewaGateway } from "@/lib/payments/esewa";
import { FonepayCheckoutGateway } from "@/lib/payments/fonepay";
import { getPaymentGateway } from "@/lib/payments";

type Ctx = { params: Promise<{ gateway: string }> };

/**
 * Gateway return URL. The query string is untrusted: we only take the
 * reference (pidx) and perform a server-side lookup. The user is redirected
 * to the wallet with a status flag; crediting (if any) already happened here.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { gateway } = await ctx.params;
  const url = new URL(req.url);
  // Khalti: ?pidx= · eSewa success: ?data=<base64 JSON> · eSewa failure: ?ref=…&failed=1 (our own URL)
  // · Fonepay: ?PRN=…&UID=…&PS=…&RC=…&DV=… (UID is needed for Fonepay's verification call).
  const fp = gateway === "fonepay" ? FonepayCheckoutGateway.parseReturn(url.searchParams) : null;
  const ref = fp ? fp.PRN ?? null : url.searchParams.get("pidx") ?? EsewaGateway.refFromReturnData(url.searchParams.get("data")) ?? url.searchParams.get("ref");
  const parsed = z.object({ gateway: z.enum(["khalti", "esewa", "fonepay", "mock"]), ref: z.string().min(1).max(200) }).safeParse({ gateway, ref });
  const wallet = new URL("/wallet", env.appUrl);
  if (!parsed.success) {
    wallet.searchParams.set("payment", "invalid");
    return NextResponse.redirect(wallet);
  }
  try {
    let hint: string | undefined;
    if (fp) {
      hint = fp.UID && /^[A-Za-z0-9-]{1,64}$/.test(fp.UID) ? fp.UID : undefined;
      // The signature is only a diagnostic: crediting depends on Fonepay's verification API.
      try {
        const g = getPaymentGateway("fonepay") as FonepayCheckoutGateway;
        if (!g.returnSignatureValid(fp)) console.warn(`[payments] fonepay return for ${parsed.data.ref}: signature did not match (verifying with Fonepay anyway)`);
      } catch {
        /* gateway switched off: confirmPaymentByRef reports it */
      }
    }
    const out = await confirmPaymentByRef(parsed.data.gateway, parsed.data.ref, undefined, hint);
    wallet.searchParams.set("payment", out.result === "credited" || out.result === "already_credited" ? "success" : out.result === "mismatch" ? "mismatch" : `pending:${(out as { status?: string }).status ?? "pending"}`);
  } catch (e) {
    console.warn(`[payments] return handler: ${(e as Error).message}`);
    wallet.searchParams.set("payment", "error");
  }
  return NextResponse.redirect(wallet);
}
