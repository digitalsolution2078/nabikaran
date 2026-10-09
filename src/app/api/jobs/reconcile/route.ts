import { handle, json, requireWorker } from "@/lib/http";
import { recordHeartbeat, runReconciler } from "@/lib/services/dispatcher";
import { reconcilePendingOrders } from "@/lib/services/payments";

export const maxDuration = 60;

/** Internal provider-report poller + payment reconciler (bearer WORKER_TOKEN). */
export async function POST(req: Request) {
  return handle(async () => {
    requireWorker(req);
    const [sms, payments] = await Promise.all([runReconciler(), reconcilePendingOrders()]);
    await recordHeartbeat("reconcile");
    return json({ ok: true, sms, payments });
  });
}

export const GET = POST;
