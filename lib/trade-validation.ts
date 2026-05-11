/**
 * trade-validation.ts
 *
 * Trade fairness rules for the (not yet implemented) league trade system.
 * Pre-built so the validation logic is in place before the trade UI ships.
 *
 * RULE: OTF BALANCE
 * ─────────────────
 * The total OTF rating sent must be within TRADE_MAX_OTF_DELTA of the total
 * OTF rating received. This prevents lopsided trades (e.g. trading a 95-rated
 * Antonelli for a 70-rated mid-tier driver) which would let collusion or
 * inexperienced managers tank league balance.
 *
 * Sum-based, not per-asset — so a 1-for-2 trade is fine as long as the totals
 * are close (e.g. 1 driver 90 for 2 pit crews 45+45 = 90 is delta 0, allowed).
 *
 * If we later observe abuse via the 1-for-N pattern, we'll add a per-asset
 * cap on top of the sum check.
 */

export const TRADE_MAX_OTF_DELTA = 10;

export interface TradeAssetSummary {
  slug:       string;
  otfRating:  number;
  assetType?: string;
}

export interface TradeValidationResult {
  valid:      boolean;
  delta:      number;     // absolute difference between the two sides' totals
  fromTotal:  number;
  toTotal:    number;
  reason?:    string;     // populated when valid === false
}

/**
 * Validates a proposed trade against the OTF balance rule.
 *
 * @param fromTeam Assets being given up by the proposing manager
 * @param toTeam   Assets being received from the counterparty
 * @param maxDelta Override the default ±10 threshold if needed
 *
 * @example
 *   const result = validateTradeOTFBalance(
 *     [{ slug: 'antonelli', otfRating: 97 }],
 *     [{ slug: 'sainz',     otfRating: 82 }],
 *   );
 *   // result.valid === false
 *   // result.delta === 15
 *   // result.reason: "OTF imbalance: 15 points (max allowed: 10)..."
 */
export function validateTradeOTFBalance(
  fromTeam: TradeAssetSummary[],
  toTeam:   TradeAssetSummary[],
  maxDelta: number = TRADE_MAX_OTF_DELTA,
): TradeValidationResult {
  if (!fromTeam.length || !toTeam.length) {
    return {
      valid:     false,
      delta:     0,
      fromTotal: 0,
      toTotal:   0,
      reason:    'Both sides of the trade must include at least one asset.',
    };
  }

  const fromTotal = fromTeam.reduce((s, a) => s + (a.otfRating ?? 0), 0);
  const toTotal   = toTeam.reduce((s, a) => s + (a.otfRating ?? 0), 0);
  const delta     = Math.abs(fromTotal - toTotal);

  if (delta > maxDelta) {
    const strongerSide = fromTotal > toTotal ? 'giving up' : 'receiving';
    return {
      valid:     false,
      delta,
      fromTotal,
      toTotal,
      reason:    `Trade blocked: OTF imbalance of ${delta} points (max allowed: ${maxDelta}). You are ${strongerSide} significantly more value.`,
    };
  }

  return { valid: true, delta, fromTotal, toTotal };
}
