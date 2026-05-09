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

  const picksRemaining = totalRounds - currentRound + 1;
  if (picksRemaining <= needed.length) {
    const priority = ['powerUnit', 'principal', 'pitCrew', 'driver'];
    for (const type of priority) {
      if (needed.includes(type)) return type;
    }
  }

  return needed[0];
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
