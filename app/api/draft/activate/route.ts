import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { DraftSession, League } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

const PRE_DRAFT_SECONDS = 3 * 60; // 3 minutes

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 'write' preset (60/min per user). Activate is normally called at most a
  // few times per draft (once to start the countdown, once to finalize) so
  // 60/min is generous.
  const rl = await checkRateLimit('write', `draft-activate:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const { leagueId } = await req.json();

  await connectDB();

  // C4: Authorization. Without this check, ANY authenticated user could POST
  // an arbitrary leagueId and trigger the pre-draft countdown / activation on
  // a league they have no stake in. Practical impact is griefing — owner
  // plans draft for 7pm, outsider activates at 6:50pm so members miss it.
  // Restrict to league members. Commissioner-only would be too restrictive:
  // if the commissioner can't be present, members still need to be able to
  // start the countdown and finalize activation.
  const league = await League.findById(leagueId).select('memberIds').lean() as any;
  if (!league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 });
  }
  const isMember = (league.memberIds as any[])
    .some(id => id.toString() === userId);
  if (!isMember) {
    return NextResponse.json({ error: 'Only league members can activate the draft' }, { status: 403 });
  }

  // Idempotency: if the draft is already active (cron beat us, or another
  // client called this endpoint first), treat it as success and return the
  // current session.
  const existing = await DraftSession.findOne({ leagueId, status: { $in: ['pending', 'active'] } });
  if (!existing) {
    return NextResponse.json({ error: 'No pending or active draft session found' }, { status: 404 });
  }

  if (existing.status === 'active') {
    return NextResponse.json(existing);
  }

  const draftSession = existing;

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
