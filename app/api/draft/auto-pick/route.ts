import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Asset, DraftSession, League, Roster } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

// Returns the assetType the drafter needs to fill next, in priority order
function neededAssetType(roster: any): string {
  if (!roster.driver1AssetId)    return 'driver';
  if (!roster.driver2AssetId)    return 'driver';
  if (!roster.principalAssetId)  return 'principal';
  if (!roster.pitCrew1AssetId)   return 'pitCrew';
  if (!roster.pitCrew2AssetId)   return 'pitCrew';
  return 'powerUnit';
}

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { leagueId } = await req.json();

  await connectDB();

  const draftSession = await DraftSession.findOne({ leagueId, status: 'active' });
  if (!draftSession) {
    return NextResponse.json({ error: 'No active draft session found' }, { status: 404 });
  }

  if (draftSession.status !== 'active') {
    return NextResponse.json({ error: 'Draft is not active' }, { status: 400 });
  }

  const currentDrafterId = draftSession.draftOrder[draftSession.currentPickIndex]?.toString();
  if (currentDrafterId !== userId) {
    return NextResponse.json({ error: 'It is not your turn to pick' }, { status: 403 });
  }

  const roster = await Roster.findOne({ leagueId, userId });
  if (!roster) {
    return NextResponse.json({ error: 'Roster not found' }, { status: 404 });
  }

  const assetType = neededAssetType(roster);

  // Find highest-rated available asset of the needed type
  const availableIds = draftSession.availableAssetIds.map((id: any) => id.toString());
  const bestAsset = await Asset
    .findOne({ _id: { $in: availableIds }, assetType, isActive: true })
    .sort({ otfRating: -1 })
    .select('_id assetType');

  if (!bestAsset) {
    return NextResponse.json({ error: `No available ${assetType} asset found` }, { status: 400 });
  }

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

  const nextDrafterId =
    draftSession.status === 'completed'
      ? null
      : draftSession.draftOrder[draftSession.currentPickIndex]?.toString() ?? null;

  return NextResponse.json({
    ...draftSession.toObject(),
    currentDrafterId: nextDrafterId,
  });
}
