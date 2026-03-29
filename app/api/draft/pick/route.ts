import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Asset, DraftSession, League, Roster } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { leagueId, assetId } = await req.json();

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

  const isAvailable = draftSession.availableAssetIds.some(
    (id: any) => id.toString() === assetId,
  );
  if (!isAvailable) {
    return NextResponse.json({ error: 'Asset is not available' }, { status: 400 });
  }

  const asset = await Asset.findById(assetId).select('assetType');
  if (!asset) {
    return NextResponse.json({ error: 'Asset not found' }, { status: 400 });
  }

  const assetType: string = asset.assetType;

  // Record the pick
  draftSession.picks.push({
    pickNumber: draftSession.currentPickIndex + 1,
    round: draftSession.currentRound,
    userId,
    assetId,
    assetType,
    pickedAt: new Date(),
  });

  // Remove from available pool (power units can be shared — don't remove them)
  if (assetType !== 'powerUnit') {
    draftSession.availableAssetIds = draftSession.availableAssetIds.filter(
      (id: any) => id.toString() !== assetId,
    );
  }

  // Update the roster slot
  const roster = await Roster.findOne({ leagueId, userId });
  console.log('[draft/pick] roster lookup — leagueId:', leagueId, 'userId:', userId);
  console.log('[draft/pick] roster before save:', roster?.toObject() ?? null);

  if (roster) {
    if (assetType === 'driver') {
      if (!roster.driver1AssetId) {
        roster.driver1AssetId = assetId;
      } else {
        roster.driver2AssetId = assetId;
      }
    } else if (assetType === 'principal') {
      roster.principalAssetId = assetId;
    } else if (assetType === 'pitCrew') {
      if (!roster.pitCrew1AssetId) {
        roster.pitCrew1AssetId = assetId;
      } else {
        roster.pitCrew2AssetId = assetId;
      }
    } else if (assetType === 'powerUnit') {
      roster.powerUnitAssetId = assetId;
    }
    roster.updatedAt = new Date();
    await roster.save();
    console.log('[draft/pick] roster after save:', roster.toObject());
  } else {
    console.warn('[draft/pick] roster NOT found for leagueId:', leagueId, 'userId:', userId);
  }

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
