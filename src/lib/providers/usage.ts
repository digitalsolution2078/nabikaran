import { getDb } from "../db";

/**
 * Counting of SMS and email that are not reminders (reminders are already in
 * sms_attempts), for Admin → Message usage. Counting never blocks or fails a send.
 */
export type MessageChannel = "sms" | "email";

export interface UsageRow {
  channel: MessageChannel;
  kind: string;
  provider: string;
  outcome: "accepted" | "rejected" | "unknown";
  segments: number;
  units: number | null;
}
export type UsageRecorder = (row: UsageRow) => Promise<void>;

/** What a message was for, from its idempotency key. "reminder" ones are not counted here. */
export function messageKind(idempotencyKey: string): string {
  const k = idempotencyKey;
  if (/^sms:|^email-/.test(k)) return "reminder";
  if (/^otp:|^code:/.test(k)) return "sign_in";
  if (k.startsWith("nudge:")) return "nudge";
  if (k.startsWith("low-credit:")) return "low_credit";
  if (k.startsWith("welcome:")) return "welcome";
  if (k.startsWith("digest-")) return "digest";
  if (k.startsWith("admin-test")) return "test";
  return "other";
}

export const recordUsageToDb: UsageRecorder = async (r) => {
  await getDb().query("insert into message_usage (channel, kind, provider, outcome, segments, units) values ($1,$2,$3,$4,$5,$6)", [
    r.channel, r.kind, r.provider, r.outcome, r.segments, r.units,
  ]);
};

export async function recordUsage(record: UsageRecorder, row: Omit<UsageRow, "kind"> & { key: string }): Promise<void> {
  const kind = messageKind(row.key);
  if (kind === "reminder") return;
  const { key: _key, ...rest } = row;
  void _key;
  await record({ ...rest, kind }).catch((e) => console.warn(`[usage] ${row.channel} not counted: ${(e as Error).message}`));
}
