import { getDb, type Db } from "./db";
import { ENSURE_STEPS } from "./schema-steps";

// Any constant shared by every app instance; serialises concurrent start-ups.
const LOCK_KEY = 7_202_610;

export interface EnsureResult {
  applied: string[];
  present: string[];
}

/**
 * Apply embedded, re-runnable schema steps that are missing (see schema-steps.ts).
 * Safe to call on every start: a step whose check passes is skipped, and a step
 * that runs is fully transactional.
 */
export async function ensureSchema(db: Db = getDb()): Promise<EnsureResult> {
  const out: EnsureResult = { applied: [], present: [] };
  for (const step of ENSURE_STEPS) {
    await db.tx(async (tx) => {
      await tx.query("select pg_advisory_xact_lock($1)", [LOCK_KEY]);
      const { rows } = await tx.query<{ ok: boolean }>(step.check);
      if (rows[0]?.ok) {
        out.present.push(step.name);
        return;
      }
      await tx.query(step.sql);
      await tx.query("insert into audit_events (actor_via, action, target_type, target_id) values ('system','schema.ensure_applied','schema',$1)", [step.name]);
      out.applied.push(step.name);
    });
  }
  return out;
}

/** True when every embedded step is in place (shown on /api/health). */
export async function schemaStatus(db: Db = getDb()): Promise<Record<string, boolean>> {
  const status: Record<string, boolean> = {};
  for (const step of ENSURE_STEPS) {
    const { rows } = await db.query<{ ok: boolean }>(step.check).catch(() => ({ rows: [{ ok: false }] }));
    status[step.name] = Boolean(rows[0]?.ok);
  }
  return status;
}
