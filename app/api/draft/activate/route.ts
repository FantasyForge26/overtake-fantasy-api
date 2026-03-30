import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { DraftSession } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

const PRE_DRAFT_SECONDS = 3 * 60; // 3 minutes

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { leagueId } = await req.json();

  await connectDB();

  const draftSession = await DraftSession.findOne({ leagueId, status: 'pending' });
  if (!draftSession) {
    return NextResponse.json({ error: 'No pending draft session found' }, { status: 404 });
  }

  if (!draftSession.preDraftStartedAt) {
    draftSession.preDraftStartedAt = new Date();
    await draftSession.save();
    return NextResponse.json({ error: 'Pre-draft countdown not complete', secondsRemaining: PRE_DRAFT_SECONDS }, { status: 400 });
  }

  const elapsed = (Date.now() - new Date(draftSession.preDraftStartedAt).getTime()) / 1000;
  if (elapsed < PRE_DRAFT_SECONDS) {
    const secondsRemaining = Math.ceil(PRE_DRAFT_SECONDS - elapsed);
    return NextResponse.json({ error: 'Pre-draft countdown not complete', secondsRemaining }, { status: 400 });
  }

  draftSession.status = 'active';
  draftSession.currentPickStartedAt = new Date();
  await draftSession.save();

  return NextResponse.json(draftSession);
}
