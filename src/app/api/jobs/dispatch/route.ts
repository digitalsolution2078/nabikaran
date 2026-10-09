import { handle, json, requireWorker } from "@/lib/http";
import { recordHeartbeat, runDispatcher } from "@/lib/services/dispatcher";

export const maxDuration = 60;

/** Internal worker only (bearer WORKER_TOKEN). Invoked every minute by cron. */
export async function POST(req: Request) {
  return handle(async () => {
    requireWorker(req);
    const summary = await runDispatcher();
    await recordHeartbeat("dispatch");
    return json({ ok: true, summary });
  });
}

/** Vercel Cron sends GET with the CRON_SECRET bearer; accept both verbs. */
export const GET = POST;
