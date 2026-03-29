import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { League, Asset, DraftSession } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

function buildSnakeDraftOrder(memberIds: string[], totalRounds: number): string[] {
  const order: string[] = [];
  for (let round = 1; round <= totalRounds; round++) {
    const roundOrder = round % 2 === 0 ? [...memberIds].reverse() : [...memberIds];
    order.push(...roundOrder);
  }
  return order;
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

  const league = await League.findById(leagueId);
  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 });
  }

  if (league.commissionerId.toString() !== userId) {
    return NextResponse.json({ error: 'Only the commissioner can start the draft' }, { status: 403 });
  }

  if (league.status !== 'setup') {
    return NextResponse.json({ error: 'League is not in setup status' }, { status: 400 });
  }

  if (league.memberIds.length < 1) {
    return NextResponse.json({ error: 'League needs at least 1 member to start a draft' }, { status: 400 });
  }

  const assets = await Asset.find({ season: 2026, confirmed: true }).select('_id');
  const availableAssetIds = assets.map((a: any) => a._id);

  const memberIds = league.memberIds.map((id: any) => id.toString());
  const totalRounds = 6;
  const draftOrder = buildSnakeDraftOrder(memberIds, totalRounds);
  const totalPicks = draftOrder.length;

  const draftSession = await DraftSession.create({
    leagueId: league._id,
    season: 2026,
    status: 'active',
    draftOrder,
    currentPickIndex: 0,
    currentRound: 1,
    totalRounds,
    totalPicks,
    availableAssetIds,
    picks: [],
    pickTimeLimitSeconds: 60,
    currentPickStartedAt: new Date(),
  });

  league.status = 'drafting';
  await league.save();

  return NextResponse.json(draftSession, { status: 201 });
}
