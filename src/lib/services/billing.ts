/**
 * Charge = billed units × the credits-per-unit price the job was RESERVED at
 * (reminder_jobs.cost_version), so a later price change never alters what an
 * already-scheduled message costs. Falls back to the current price ($3) only
 * for legacy jobs without a cost version.
 *   $1 job id, $2 units (quoted), $3 fallback price, $4 ledger idempotency key
 */
export const BOOKED_COMMIT = `select wallet_commit_for_job($1::uuid,
  $2::bigint * coalesce((select pv.credits_per_billable_unit from reminder_jobs j join pricing_versions pv on pv.id = j.cost_version where j.id = $1::uuid), $3::bigint),
  $4::text)`;

/**
 * Refund policy (customer-facing): you pay only for messages the provider
 * accepted and did not later report as failed.
 *  - rejected before acceptance → reservation released (never charged)
 *  - accepted, then reported failed (SMS DLR or WhatsApp webhook) → debit reversed
 *  - unknown → held until reconciled; unresolved WhatsApp after 6 h → released
 */
export const REFUND_POLICY = "failed messages are not charged; a charge is reversed if the provider later reports failure";
