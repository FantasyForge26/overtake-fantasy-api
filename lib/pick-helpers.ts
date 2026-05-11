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
 * Per-asset-type draft priority. Higher = picked first when slots are open
 * across multiple types. Reflects approximate per-race fantasy points
 * contribution — drivers score ~50/race, principals ~25-30, pit crews ~15-20,
 * power units ~10-15. The OTF score is normalised to 0-100 across all types
 * for visual comparison, but in raw points terms a 75-rated driver is worth
 * far more than a 75-rated PU. Tier-then-OTF prevents auto-draft from
 * "wasting" early picks on a high-rated low-tier asset when stronger drivers
 * are still on the board.
 */
export const ASSET_TYPE_DRAFT_TIER: Record<string, number> = {
  driver:    4,
  principal: 3,
  pitCrew:   2,
  powerUnit: 1,
};

/**
 * Sorts a list of asset candidates by (tier desc, otfRating desc) and returns
 * the best pick. Used by auto-pick handlers as the FALLBACK selection logic
 * when the user's queue doesn't have an applicable pick.
 */
export function sortCandidatesForAutoDraft<T extends { assetType: string; otfRating?: number }>(
  candidates: T[],
): T[] {
  return [...candidates].sort((a, b) => {
    const tierDiff = (ASSET_TYPE_DRAFT_TIER[b.assetType] ?? 0) - (ASSET_TYPE_DRAFT_TIER[a.assetType] ?? 0);
    if (tierDiff !== 0) return tierDiff;
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
 * For driver and pitCrew (two slots each), reads the roster to determine which slot is open.
 */
export async function assignRosterSlot(
  leagueId: string | mongoose.Types.ObjectId,
  userId: string | mongoose.Types.ObjectId,
  assetId: mongoose.Types.ObjectId | string,
  assetType: string,
): Promise<void> {
  if (assetType === 'driver') {
    const roster = await Roster.findOne({ leagueId, userId });
    if (!roster) return;
    if (!roster.driver1AssetId) { roster.driver1AssetId = assetId; }
    else { roster.driver2AssetId = assetId; }
    roster.updatedAt = new Date();
    await roster.save();
    return;
  }

  if (assetType === 'pitCrew') {
    const roster = await Roster.findOne({ leagueId, userId });
    if (!roster) return;
    if (!roster.pitCrew1AssetId) { roster.pitCrew1AssetId = assetId; }
    else { roster.pitCrew2AssetId = assetId; }
    roster.updatedAt = new Date();
    await roster.save();
    return;
  }

  const fieldMap: Record<string, string> = {
    principal: 'principalAssetId',
    powerUnit:  'powerUnitAssetId',
  };
  const field = fieldMap[assetType];
  if (field) {
    await Roster.updateOne(
      { leagueId, userId },
      { $set: { [field]: assetId, updatedAt: new Date() } },
    );
  }
}
