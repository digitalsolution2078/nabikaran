import { handle, json, requireUser } from "@/lib/http";
import { getLedger, getWallet } from "@/lib/services/wallet";
import { listOrders } from "@/lib/services/payments";

export async function GET(req: Request) {
  return handle(async () => {
    const user = await requireUser(req);
    const [wallet, ledger, orders] = await Promise.all([getWallet(user.id), getLedger(user.id), listOrders(user.id)]);
    return json({ wallet, ledger, orders });
  });
}
