import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { DraftSession } from '@/lib/models';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ leagueId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { leagueId } = await params;

  await connectDB();

  const draftSession = await DraftSession.findOne({ leagueId, status: 'active' })
    .populate('availableAssetIds');

  if (!draftSession) {
    return NextResponse.json({ error: 'No active draft session found' }, { status: 404 });
  }

  const currentDrafterId = draftSession.draftOrder[draftSession.currentPickIndex] ?? null;

  return NextResponse.json({
    ...draftSession.toObject(),
    currentDrafterId,
    currentRound: draftSession.currentRound,
    picks: draftSession.picks,
  });
}
