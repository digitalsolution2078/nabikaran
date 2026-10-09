import { NextResponse } from "next/server";
import { z } from "zod";
import { confirmPaymentByRef } from "@/lib/services/payments";
import { env } from "@/lib/env";

type Ctx = { params: Promise<{ gateway: string }> };

/**
 * Gateway return URL. The query string is untrusted: we only take the
 * reference (pidx) and perform a server-side lookup. The user is redirected
 * to the wallet with a status flag; crediting (if any) already happened here.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { gateway } = await ctx.params;
  const url = new URL(req.url);
  const ref = url.searchParams.get("pidx") ?? url.searchParams.get("ref");
  const parsed = z.object({ gateway: z.enum(["khalti", "esewa", "mock"]), ref: z.string().min(1).max(200) }).safeParse({ gateway, ref });
  const wallet = new URL("/wallet", env.appUrl);
  if (!parsed.success) {
    wallet.searchParams.set("payment", "invalid");
    return NextResponse.redirect(wallet);
  }
  try {
    const out = await confirmPaymentByRef(parsed.data.gateway, parsed.data.ref);
    wallet.searchParams.set("payment", out.result === "credited" || out.result === "already_credited" ? "success" : out.result === "mismatch" ? "mismatch" : `pending:${(out as { status?: string }).status ?? "pending"}`);
  } catch (e) {
    console.warn(`[payments] return handler: ${(e as Error).message}`);
    wallet.searchParams.set("payment", "error");
  }
  return NextResponse.redirect(wallet);
}
