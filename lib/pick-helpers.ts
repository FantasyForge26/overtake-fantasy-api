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
