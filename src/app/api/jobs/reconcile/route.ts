import { handle, json, requireWorker } from "@/lib/http";
import { recordHeartbeat, runReconciler } from "@/lib/services/dispatcher";
import { reconcilePendingOrders } from "@/lib/services/payments";
import { sweepGatewayTopups } from "@/lib/services/manual-topups";
import { pruneOAuth } from "@/lib/oauth/tokens";
import { pruneRateLimitWindows } from "@/lib/core/rate-limit";
import { prunePreparedActions } from "@/lib/core/prepared-actions";
import { getDb } from "@/lib/db";

export const maxDuration = 60;

/** Internal provider-report poller + payment reconciler (bearer WORKER_TOKEN). */
export async function POST(req: Request) {
  return handle(async () => {
    requireWorker(req);
    const [sms, payments, qrTopups] = await Promise.all([runReconciler(), reconcilePendingOrders(), sweepGatewayTopups()]);
    await Promise.all([pruneOAuth(), pruneRateLimitWindows(getDb()), prunePreparedActions()]);
    await recordHeartbeat("reconcile");
    return json({ ok: true, sms, payments, qrTopups });
  });
}

export const GET = POST;
