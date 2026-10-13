/** Top-up bonus tiers (admin-set; mirrored by SQL topup_bonus_credits). Shared by server and client. */
export interface BonusTier { minNpr: number; percent: number }

/** Bonus credits for a top-up of `npr` rupees: the highest tier reached, two decimals. */
export function bonusFor(npr: number, tiers: BonusTier[]): number {
  const tier = [...tiers].sort((a, b) => b.minNpr - a.minNpr).find((t) => npr >= t.minNpr);
  return tier ? Math.round(npr * tier.percent) / 100 : 0;
}

/** The next tier above `npr`, to nudge "add NPR X more for Y% bonus". */
export function nextTier(npr: number, tiers: BonusTier[]): BonusTier | null {
  return [...tiers].sort((a, b) => a.minNpr - b.minNpr).find((t) => t.minNpr > npr) ?? null;
}
