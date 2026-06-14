import mongoose from 'mongoose';
import { DraftSession, Roster } from './models';

export interface PickDoc {
  pickNumber: number;
  round: number;
  userId: string | mongoose.Types.ObjectId;
  assetId: mongoose.Types.ObjectId | string;
  assetType: string;
  pickedAt: Date;
}

/**
 * Returns the next asset type the drafter should pick, or null if their roster is full.
 * Uses fill-in-order priority by default (driver, driver, principal, pitCrew, pitCrew, powerUnit)
 * with a late-round override: when picks remaining <= unfilled slots, prioritize rarest slots
 * first (powerUnit > principal > pitCrew > driver) so users don't end up missing a category.
 */
export function nextNeededAssetType(
  roster: any,
  currentRound: number,
  totalRounds: number,
): string | null {
  const needed: string[] = [];
  if (!roster.driver1AssetId)   needed.push('driver');
  if (!roster.driver2AssetId)   needed.push('driver');
  if (!roster.principalAssetId) needed.push('principal');
  if (!roster.pitCrew1AssetId)  needed.push('pitCrew');
  if (!roster.pitCrew2AssetId)  needed.push('pitCrew');
  if (!roster.powerUnitAssetId) needed.push('powerUnit');

  if (needed.length === 0) return null;

  // Late-round rare-type override: only kick in once picks are STRICTLY fewer
  // than open slots (an impossible state in a balanced snake draft, so this is
  // effectively a safety net for hand-edited rosters). Previously this used <=
  // and triggered on round 1 of every fresh roster because picks === slots.
  const picksRemaining = totalRounds - currentRound + 1;
  if (picksRemaining < needed.length) {
    const priority = ['powerUnit', 'principal', 'pitCrew', 'driver'];
    for (const type of priority) {
      if (needed.includes(type)) return type;
    }
  }

  return needed[0];
}

/**
 * Returns the unique set of asset types the roster still needs. Used by the
 * auto-pick code paths to query "highest OTF across all open slot types"
 * instead of being locked into one type at a time.
 */
export function neededAssetTypes(roster: any): string[] {
  const needed = new Set<string>();
  if (!roster.driver1AssetId   || !roster.driver2AssetId)   needed.add('driver');
  if (!roster.principalAssetId)                              needed.add('principal');
  if (!roster.pitCrew1AssetId  || !roster.pitCrew2AssetId)  needed.add('pitCrew');
  if (!roster.powerUnitAssetId)                              needed.add('powerUnit');
  return Array.from(needed);
}

/**
 * Returns true if the roster has an open slot for the given asset type.
 *
 * Used by /api/draft/pick to reject over-draft attempts BEFORE atomicClaimAsset
 * runs. Without this check, a user could pick a third driver and the server
 * would silently overwrite their driver2 slot (the existing assignRosterSlot
 * code did `else { driver2 = newAsset }` with no guard).
 *
 * Roster slot caps: 2 drivers, 1 principal, 2 pit crews, 1 power unit (6 total).
 */
export function hasOpenSlotForType(roster: any, assetType: string): boolean {
  if (!roster) return false;
  switch (assetType) {
    case 'driver':    return !roster.driver1AssetId || !roster.driver2AssetId;
    case 'principal': return !roster.principalAssetId;
    case 'pitCrew':   return !roster.pitCrew1AssetId || !roster.pitCrew2AssetId;
    case 'powerUnit': return !roster.powerUnitAssetId;
    default:          return false;
  }
}

/**
 * Per-asset-type expected-points-per-race weighting. Reflects approximate
 * fantasy points contribution:
 *   - drivers     ~50 pts/race
 *   - principals  ~25-30 pts/race
 *   - pit crews   ~15-20 pts/race
 *   - power units ~10-15 pts/race
 *
 * Used by sortCandidatesForAutoDraft to convert raw OTF rating (which is
 * normalised 0-100 across all asset types) into an "expected value" that
 * compares fairly across types:
 *
 *   expectedValue = otfRating * weight
 *
 * Sort by expectedValue desc and you get the genuinely best asset, regardless
 * of type. Examples:
 *
 *   - 60 OTF driver  → 60.0   beats   95 OTF power unit → 23.75
 *   - 95 OTF principal → 52.25 beats   50 OTF driver    → 50.0
 *
 * F6: previously this was tier-first then OTF, which meant a CPU always
 * picked driver > principal > pitCrew > powerUnit regardless of OTF. Beta
 * testers reported bots drafting in obvious position order rather than
 * taking the best asset. Weighted-value sort fixes that while still
 * respecting per-race points realism.
 */
export const ASSET_TYPE_VALUE_WEIGHT: Record<string, number> = {
  driver:    1.0,
  principal: 0.55,
  pitCrew:   0.35,
  powerUnit: 0.25,
};

/**
 * Sorts a list of asset candidates by (expectedValue desc, otfRating desc as
 * tiebreaker) and returns the best pick. Used by auto-pick handlers as the
 * FALLBACK selection logic when the user's queue doesn't have an applicable
 * pick. The roster's open-slot constraint is applied upstream — by the time
 * candidates reach this function, they're guaranteed to match an open slot.
 */
export function sortCandidatesForAutoDraft<T extends { assetType: string; otfRating?: number }>(
  candidates: T[],
): T[] {
  return [...candidates].sort((a, b) => {
    const aValue = (a.otfRating ?? 0) * (ASSET_TYPE_VALUE_WEIGHT[a.assetType] ?? 0);
    const bValue = (b.otfRating ?? 0) * (ASSET_TYPE_VALUE_WEIGHT[b.assetType] ?? 0);
    if (aValue !== bValue) return bValue - aValue;
    // Tiebreaker on raw OTF (rare — only fires when expectedValue is exactly equal).
    return (b.otfRating ?? 0) - (a.otfRating ?? 0);
  });
}

/**
 * Atomically claims an asset from the draft session in a single MongoDB operation.
 *
 * The filter requires ALL of:
 *   - status: 'active'              — session must still be running
 *   - currentPickIndex: pickIndex   — only one request can advance a given pick slot
 *   - availableAssetIds: assetId    — only one request can claim a given asset
 *
 * Because both conditions are in the same atomic filter, two concurrent requests
 * racing on the same pick slot will have exactly one winner. The loser gets null.
 *
 * Returns the updated DraftSession (new: true), or null if the race was lost.
 */
export async function atomicClaimAsset(params: {
  sessionId: mongoose.Types.ObjectId | string;
  assetId: mongoose.Types.ObjectId | string;
  pickIndex: number;
  newPickIndex: number;
  newRound: number;
  pickDoc: PickDoc;
}): Promise<any | null> {
  const { sessionId, assetId, pickIndex, newPickIndex, newRound, pickDoc } = params;

  return DraftSession.findOneAndUpdate(
    {
      _id: sessionId,
      status: 'active',
      currentPickIndex: pickIndex,
      availableAssetIds: assetId,
    },
    {
      $pull: { availableAssetIds: assetId },
      $push: { picks: pickDoc },
      $set: {
        currentPickIndex: newPickIndex,
        currentRound: newRound,
        currentPickStartedAt: new Date(),
      },
    },
    { new: true },
  );
}

const ROSTER_ASSET_FIELDS = [
  'driver1AssetId', 'driver2AssetId',
  'principalAssetId',
  'pitCrew1AssetId', 'pitCrew2AssetId',
  'powerUnitAssetId',
] as const;

/**
 * Defense-in-depth guard: throws if the asset is already assigned to any roster
 * in this league. Call this AFTER atomicClaimAsset succeeds but BEFORE writing to
 * the roster. Catches bugs that bypass the draft session (manual /add calls, out-of-
 * sync availableAssetIds, or future code paths that forget atomicClaimAsset).
 *
 * If this throws, the caller must roll back by adding the asset back to
 * availableAssetIds.
 */
export async function assertAssetNotOnAnyRoster(
  leagueId: string | mongoose.Types.ObjectId,
  assetId: mongoose.Types.ObjectId | string,
): Promise<void> {
  const assetIdStr = assetId.toString();
  const allRosters = await Roster.find({ leagueId }).lean() as any[];

  for (const roster of allRosters) {
    for (const field of ROSTER_ASSET_FIELDS) {
      if (roster[field]?.toString() === assetIdStr) {
        throw new Error(
          `DUPLICATE_ASSET: ${assetIdStr} already assigned to roster ${roster._id} (${field})`,
        );
      }
    }
  }
}

/**
 * Rolls back a successful atomic claim by re-adding the asset to availableAssetIds.
 * Call this if assertAssetNotOnAnyRoster throws after a successful atomicClaimAsset.
 */
export async function rollbackClaim(
  sessionId: mongoose.Types.ObjectId | string,
  assetId: mongoose.Types.ObjectId | string,
): Promise<void> {
  await DraftSession.updateOne(
    { _id: sessionId },
    { $addToSet: { availableAssetIds: assetId } },
  );
}

/**
 * Assigns the picked asset to the correct roster slot.
 *
 * Defense-in-depth: THROWS `SLOT_FULL: <type>` if no open slot exists for the
 * asset type. Previously this silently overwrote slot 2 (driver2 / pitCrew2)
 * when both slots were already filled, OR overwrote the principal/powerUnit
 * slot via unconditional $set. Either case corrupted the roster.
 *
 * Callers MUST guard with hasOpenSlotForType BEFORE invoking this. The throw
 * here is a safety net for any future code path that forgets to check.
 */
export async function assignRosterSlot(
  leagueId: string | mongoose.Types.ObjectId,
  userId: string | mongoose.Types.ObjectId,
  assetId: mongoose.Types.ObjectId | string,
  assetType: string,
): Promise<void> {
  if (assetType === 'driver') {
    const roster = await Roster.findOne({ leagueId, userId });
    if (!roster) throw new Error('ROSTER_NOT_FOUND');
    if (!roster.driver1AssetId)      { roster.driver1AssetId = assetId; }
    else if (!roster.driver2AssetId) { roster.driver2AssetId = assetId; }
    else throw new Error('SLOT_FULL: driver');
    roster.updatedAt = new Date();
    await roster.save();
    return;
  }

  if (assetType === 'pitCrew') {
    const roster = await Roster.findOne({ leagueId, userId });
    if (!roster) throw new Error('ROSTER_NOT_FOUND');
    if (!roster.pitCrew1AssetId)      { roster.pitCrew1AssetId = assetId; }
    else if (!roster.pitCrew2AssetId) { roster.pitCrew2AssetId = assetId; }
    else throw new Error('SLOT_FULL: pitCrew');
    roster.updatedAt = new Date();
    await roster.save();
    return;
  }

  if (assetType === 'principal' || assetType === 'powerUnit') {
    const field = assetType === 'principal' ? 'principalAssetId' : 'powerUnitAssetId';
    // Filter requires the slot to be unset — atomic guard against overwrite.
    const result = await Roster.updateOne(
      { leagueId, userId, [field]: { $in: [null, undefined] } },
      { $set: { [field]: assetId, updatedAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      throw new Error(`SLOT_FULL: ${assetType}`);
    }
    return;
  }

  throw new Error(`UNKNOWN_ASSET_TYPE: ${assetType}`);
}
