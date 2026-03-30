import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Asset, DraftSession, DraftQueue, League, Roster } from '@/lib/models';

function neededAssetType(roster: any): string {
  if (!roster.driver1AssetId)   return 'driver';
  if (!roster.driver2AssetId)   return 'driver';
  if (!roster.principalAssetId) return 'principal';
  if (!roster.pitCrew1AssetId)  return 'pitCrew';
  if (!roster.pitCrew2AssetId)  return 'pitCrew';
  return 'powerUnit';
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const activeSessions = await DraftSession.find({ status: 'active' });

  const now = Date.now();
  let processed = 0;

  for (const draftSession of activeSessions) {
    const expiresAt =
      new Date(draftSession.currentPickStartedAt).getTime() +
      draftSession.pickTimeLimitSeconds * 1000;

    if (now < expiresAt) continue;

    const userId = draftSession.draftOrder[draftSession.currentPickIndex]?.toString();
    if (!userId) continue;

    const leagueId = draftSession.leagueId.toString();

    const roster = await Roster.findOne({ leagueId, userId });
    if (!roster) continue;

    const assetType = neededAssetType(roster);

    const availableIds = draftSession.availableAssetIds.map((id: any) => id.toString());

    // Check queue first
    const draftQueue = await DraftQueue.findOne({ leagueId, userId });
    const queuedIds = draftQueue?.queue?.map((id: any) => id.toString()) ?? [];
    const queuedPickId = queuedIds.find((qid: string) => availableIds.includes(qid));

    let bestAsset: any = null;
    if (queuedPickId) {
      const queued = await Asset.findOne({ _id: queuedPickId, assetType, isActive: true }).select('_id assetType');
      if (queued) bestAsset = queued;
    }

    // Fall back to highest OTF rating
    if (!bestAsset) {
      bestAsset = await Asset
        .findOne({ _id: { $in: availableIds }, assetType, isActive: true })
        .sort({ otfRating: -1 })
        .select('_id assetType');
    }

    if (!bestAsset) continue;

    const assetId = bestAsset._id.toString();

    // Record the pick
    draftSession.picks.push({
      pickNumber: draftSession.currentPickIndex + 1,
      round: draftSession.currentRound,
      userId,
      assetId: bestAsset._id,
      assetType,
      pickedAt: new Date(),
    });

    // Remove from available pool
    draftSession.availableAssetIds = draftSession.availableAssetIds.filter(
      (id: any) => id.toString() !== assetId,
    );

    // Update roster slot
    if (assetType === 'driver') {
      if (!roster.driver1AssetId) {
        roster.driver1AssetId = bestAsset._id;
      } else {
        roster.driver2AssetId = bestAsset._id;
      }
    } else if (assetType === 'principal') {
      roster.principalAssetId = bestAsset._id;
    } else if (assetType === 'pitCrew') {
      if (!roster.pitCrew1AssetId) {
        roster.pitCrew1AssetId = bestAsset._id;
      } else {
        roster.pitCrew2AssetId = bestAsset._id;
      }
    } else if (assetType === 'powerUnit') {
      roster.powerUnitAssetId = bestAsset._id;
    }
    roster.updatedAt = new Date();
    await roster.save();

    // Advance pick index
    const memberCount = draftSession.draftOrder.length / draftSession.totalRounds;
    draftSession.currentPickIndex += 1;
    draftSession.currentRound = Math.floor(draftSession.currentPickIndex / memberCount) + 1;
    draftSession.currentPickStartedAt = new Date();

    // Check if draft is complete
    if (draftSession.currentPickIndex >= draftSession.totalPicks) {
      draftSession.status = 'completed';
      draftSession.completedAt = new Date();

      const league = await League.findById(leagueId);
      if (league) {
        league.status = 'active';
        await league.save();
      }
    }

    await draftSession.save();
    processed++;
  }

  return NextResponse.json({ processed });
}
