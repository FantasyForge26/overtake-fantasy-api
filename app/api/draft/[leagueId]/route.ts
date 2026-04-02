import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { DraftSession, Asset, User } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ leagueId: string }> },
) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { leagueId } = await params;

  await connectDB();

  const draftSession = await DraftSession.findOne({ leagueId, status: { $in: ['active', 'pending'] } })
    .populate('availableAssetIds');

  if (!draftSession) {
    return NextResponse.json({ error: 'No active draft session found' }, { status: 404 });
  }

  const currentDrafterId = draftSession.draftOrder[draftSession.currentPickIndex] ?? null;

  // Build managers array with isAI flag
  const totalRounds = draftSession.totalRounds ?? 6;
  const memberCount = Math.round(draftSession.draftOrder.length / totalRounds);
  const uniqueManagerIds = draftSession.draftOrder.slice(0, memberCount).map((id: any) => id.toString());
  const managerUsers = await Promise.all(
    uniqueManagerIds.map(async (uid: string) => {
      const user = await User.findById(uid).select('displayName isAI avatarUrl').lean() as any;
      return { userId: uid, displayName: user?.displayName ?? 'Unknown', isAI: user?.isAI ?? false, avatarUrl: user?.avatarUrl ?? null };
    })
  );

  // Populate asset names in picks
  const populatedPicks = await Promise.all(
    draftSession.picks.map(async (pick: any) => {
      const asset = await Asset.findById(pick.assetId).select('name assetType');
      return {
        ...pick.toObject(),
        assetName: asset?.name ?? '',
        assetType: asset?.assetType ?? pick.assetType,
      };
    })
  );

  return NextResponse.json({
    ...draftSession.toObject(),
    currentDrafterId,
    currentRound: draftSession.currentRound,
    picks: populatedPicks,
    managers: managerUsers,
    autoDraftUserIds: draftSession.autoDraftUserIds ?? [],
  });
}
