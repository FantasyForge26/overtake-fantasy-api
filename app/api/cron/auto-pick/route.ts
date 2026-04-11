import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Asset, DraftSession, DraftQueue, League, Roster } from '@/lib/models';
import { sendPushToUser, sendPushToUsers } from '@/lib/push';

function neededAssetTypes(roster: any): string[] {
  const needed: string[] = [];
  if (!roster.driver1AssetId || !roster.driver2AssetId) needed.push('driver');
  if (!roster.principalAssetId)                         needed.push('principal');
  if (!roster.pitCrew1AssetId || !roster.pitCrew2AssetId) needed.push('pitCrew');
  if (!roster.powerUnitAssetId)                         needed.push('powerUnit');
  return needed;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const querySecret = req.nextUrl.searchParams.get('secret');
  const secret = process.env.CRON_SECRET;
  if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();
  const activeSessions = await DraftSession.find({ status: 'active' });
  const now = Date.now();
  let processed = 0;

  for (const draftSession of activeSessions) {
    const userId = draftSession.draftOrder[draftSession.currentPickIndex]?.toString();
    if (!userId) continue;

    const isAutoDraft = draftSession.autoDraftUserIds?.includes(userId) ?? false;

    // If user is in auto-draft, force pick immediately (treat as expired 4s ago)
    // Otherwise check if timer has expired normally
    if (!isAutoDraft) {
      const expiresAt =
        new Date(draftSession.currentPickStartedAt).getTime() +
        draftSession.pickTimeLimitSeconds * 1000;
      if (now < expiresAt) continue;
    }

    const leagueId = draftSession.leagueId.toString();
    const roster = await Roster.findOne({ leagueId, userId });
    if (!roster) continue;

    const neededTypes = neededAssetTypes(roster);
    if (neededTypes.length === 0) continue;

    const availableIds = draftSession.availableAssetIds.map((id: any) => id.toString());

    // Check queue first — pick the first queued asset whose type fills an open slot
    const draftQueue = await DraftQueue.findOne({ leagueId, userId });
    const queuedIds = draftQueue?.queue?.map((id: any) => id.toString()) ?? [];
    const queuedPickId = queuedIds.find((qid: string) => availableIds.includes(qid));

    let bestAsset: any = null;
    if (queuedPickId) {
      const queued = await Asset.findOne({
        _id: queuedPickId,
        assetType: { $in: neededTypes },
        isActive: true,
      }).select('_id assetType');
      if (queued) bestAsset = queued;
    }

    // Fall back to the highest OTF asset across all needed slot types
    if (!bestAsset) {
      bestAsset = await Asset
        .findOne({ _id: { $in: availableIds }, assetType: { $in: neededTypes }, isActive: true })
        .sort({ otfRating: -1 })
        .select('_id assetType');
    }

    if (!bestAsset) continue;

    const assetType = bestAsset.assetType as string;
    const assetId = bestAsset._id.toString();

    // Mark user as auto-draft BEFORE saving so clients see it immediately
    if (!draftSession.autoDraftUserIds) draftSession.autoDraftUserIds = [];
    if (!draftSession.autoDraftUserIds.includes(userId)) {
      draftSession.autoDraftUserIds.push(userId);
      draftSession.markModified('autoDraftUserIds');
    }

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
    draftSession.markModified('availableAssetIds');

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

    // Push notifications
    if (draftSession.status === 'completed') {
      const allUserIds = draftSession.draftOrder.map((id: any) => id.toString());
      sendPushToUsers(allUserIds, 'Draft complete! 🏁', 'Your team is set. Head to your paddock.', { screen: 'home', leagueId }, 'general').catch(() => {});
    } else {
      const nextUserId = draftSession.draftOrder[draftSession.currentPickIndex]?.toString();
      if (nextUserId) {
        sendPushToUser(nextUserId, "You're on the clock! 🏎", 'Make your draft pick now.', { screen: 'draft', leagueId }, 'draft_turn').catch(() => {});
      }
    }
  }

  return NextResponse.json({ processed });
}
