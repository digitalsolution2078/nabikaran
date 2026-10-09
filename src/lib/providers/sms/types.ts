/**
 * Provider adapter contract. Outcomes are normalized so the dispatcher never
 * depends on a specific vendor's response shape (PRD §8).
 *
 *  accepted  provider took the message; charge once, record message id/units
 *  rejected  definite refusal before accepting; no charge, retry only if transient
 *  unknown   request outcome ambiguous (timeout, 5xx after send, malformed
 *            response); MUST be reconciled via report, never blindly resent
 */
export type SendOutcome =
  | { kind: "accepted"; providerMessageId: string; units?: number; raw?: unknown }
  | { kind: "rejected"; transient: boolean; reason: string; raw?: unknown }
  | { kind: "unknown"; reason: string; raw?: unknown };

export type ReportStatus = "delivered" | "failed" | "pending" | "unknown";

export interface ReportResult {
  providerMessageId: string;
  status: ReportStatus;
  units?: number;
  raw?: unknown;
}

export interface SmsProvider {
  readonly name: string;
  send(input: { to: string; text: string; idempotencyKey: string }): Promise<SendOutcome>;
  /** Fetch delivery reports for the given provider message ids. */
  report(providerMessageIds: string[]): Promise<ReportResult[]>;
  /**
   * Look up whether a message with our idempotency key / client reference
   * was accepted, for reconciling "unknown" attempts. Providers without
   * client references return null (manual action required).
   */
  findByClientRef?(idempotencyKey: string): Promise<ReportResult | null>;
}
