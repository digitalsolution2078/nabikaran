/**
 * Pure reminder scheduling algorithm (no I/O). See PRD §7.
 *
 *  - candidate due_at = expiry_at - offset
 *  - drop past-due candidates and duplicates
 *  - cap at MAX_REMINDERS_PER_CYCLE
 *  - candidates beyond SCHEDULING_HORIZON_DAYS are "planned" (no reservation yet);
 *    the reconciler promotes them into the horizon later, never silently dropping them.
 */
export const MAX_REMINDERS_PER_CYCLE = 10;
export const SCHEDULING_HORIZON_DAYS = 730;
export const PRESET_OFFSET_DAYS = [30, 15, 7, 3, 1, 0] as const;
export const MAX_OFFSET_MINUTES = 5 * 365 * 24 * 60;

export interface RuleInput {
  offsetMinutes: number;
  enabled?: boolean;
  ruleId?: string;
}

export interface Candidate {
  offsetMinutes: number;
  ruleId?: string;
  dueAtUtc: Date;
  horizon: "within" | "beyond";
}

export interface PlanResult {
  candidates: Candidate[];
  droppedPast: number;
  droppedDuplicate: number;
  droppedOverCap: number;
}

export function normalizeOffsets(rules: RuleInput[]): RuleInput[] {
  const seen = new Set<number>();
  const out: RuleInput[] = [];
  for (const r of rules) {
    if (!Number.isInteger(r.offsetMinutes) || r.offsetMinutes < 0 || r.offsetMinutes > MAX_OFFSET_MINUTES) continue;
    if (r.enabled === false) continue;
    if (seen.has(r.offsetMinutes)) continue;
    seen.add(r.offsetMinutes);
    out.push(r);
  }
  return out.sort((a, b) => b.offsetMinutes - a.offsetMinutes);
}

export function planReminders(expiryAtUtc: Date, rules: RuleInput[], now: Date = new Date()): PlanResult {
  const normalized = normalizeOffsets(rules);
  const droppedDuplicate = rules.filter((r) => r.enabled !== false).length - normalized.length;
  const horizonEnd = now.getTime() + SCHEDULING_HORIZON_DAYS * 86_400_000;
  const seenDue = new Set<number>();
  const candidates: Candidate[] = [];
  let droppedPast = 0;
  let dupDue = 0;
  for (const r of normalized) {
    const due = new Date(expiryAtUtc.getTime() - r.offsetMinutes * 60_000);
    if (due.getTime() <= now.getTime()) {
      droppedPast++;
      continue;
    }
    if (seenDue.has(due.getTime())) {
      dupDue++;
      continue;
    }
    seenDue.add(due.getTime());
    candidates.push({
      offsetMinutes: r.offsetMinutes,
      ruleId: r.ruleId,
      dueAtUtc: due,
      horizon: due.getTime() <= horizonEnd ? "within" : "beyond",
    });
  }
  // Earliest-due first; keep the first MAX per cycle.
  candidates.sort((a, b) => a.dueAtUtc.getTime() - b.dueAtUtc.getTime());
  const kept = candidates.slice(0, MAX_REMINDERS_PER_CYCLE);
  return {
    candidates: kept,
    droppedPast,
    droppedDuplicate: droppedDuplicate + dupDue,
    droppedOverCap: candidates.length - kept.length,
  };
}

export function offsetFromParts(days = 0, hours = 0, minutes = 0): number {
  return days * 1440 + hours * 60 + minutes;
}

export function describeOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "on expiry";
  const d = Math.floor(offsetMinutes / 1440);
  const h = Math.floor((offsetMinutes % 1440) / 60);
  const m = offsetMinutes % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return `${parts.join(" ")} before`;
}

/** Retry backoff for transient provider failures: 1, 2, 4, 8, 16 min (capped). */
export const MAX_SEND_ATTEMPTS = 5;
export function retryDelayMs(attemptNo: number): number {
  return Math.min(16, 2 ** Math.max(0, attemptNo - 1)) * 60_000;
}
