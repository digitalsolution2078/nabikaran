import { handle, json, requirePrincipal } from "@/lib/http";
import { getLedger, getWalletSummary } from "@/lib/core/wallet";
import { listOrders } from "@/lib/services/payments";

export async function GET(req: Request) {
  return handle(async () => {
    const { user, principal } = await requirePrincipal(req);
    const [wallet, ledger, orders] = await Promise.all([getWalletSummary(principal), getLedger(principal), listOrders(user.id)]);
    return json({ wallet, ledger, orders });
  });
}
