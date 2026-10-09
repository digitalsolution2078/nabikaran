import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Public liveness/readiness for uptime monitors (PRD §11: alert if no
 * dispatcher run for >= 3 minutes). Exposes no secrets or user data.
 */
export async function GET() {
  const startedAt = Date.now();
  try {
    const { rows } = await getDb().query<{ at: string | null }>(
      "select max(created_at)::text as at from audit_events where action = 'worker.heartbeat' and target_id = 'dispatch'",
    );
    const last = rows[0]?.at ? new Date(rows[0].at) : null;
    const ageMin = last ? Math.round((Date.now() - last.getTime()) / 60_000) : null;
    const dispatcherOk = ageMin !== null && ageMin < 3;
    return NextResponse.json(
      { status: dispatcherOk ? "ok" : "degraded", db: "ok", dispatcher: { lastRunAt: last?.toISOString() ?? null, minutesAgo: ageMin, ok: dispatcherOk }, latencyMs: Date.now() - startedAt },
      { status: dispatcherOk ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ status: "down", db: "error", error: (e as Error).message.slice(0, 120) }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
