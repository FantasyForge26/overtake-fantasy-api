import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { DraftSession } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { performAutoPick, runAutoPickCascade } from '@/lib/pick-helpers';
import { sendPushToUser, sendPushToUsers } from '@/lib/push';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 'write' preset (60/min per user). Pairs with draft/pick — same cadence
  // ceiling. Gated downstream by currentDrafterId check.
  const rl = await checkRateLimit('write', `draft-auto-pick:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const { leagueId } = await req.json();

  await connectDB();

  const draftSession = await DraftSession.findOne({ leagueId, status: 'active' });
  if (!draftSession) {
    return NextResponse.json({ error: 'No active draft session found' }, { status: 404 });
  }

  const currentDrafterId = draftSession.draftOrder[draftSession.currentPickIndex]?.toString();
  if (currentDrafterId !== userId) {
    return NextResponse.json({ error: 'It is not your turn to pick' }, { status: 403 });
  }

  // F5: shared auto-pick helper does all the work (queue lookup, weighted
  // best-available fallback, atomic claim, slot assignment, completion).
  const result = await performAutoPick(leagueId, userId);
  if (!result.success) {
    if (result.error === 'ROSTER_FULL') {
      return NextResponse.json({ error: 'Roster is already full' }, { status: 400 });
    }
    if (result.error === 'ATOMIC_CLAIM_FAILED') {
      return NextResponse.json({ error: 'Pick slot already taken — please retry' }, { status: 409 });
    }
    if (result.error?.startsWith('DUPLICATE_ASSET') || result.error?.startsWith('SLOT_FULL')) {
      return NextResponse.json({ error: 'Pick conflict — please retry' }, { status: 409 });
    }
    if (result.error?.startsWith('NO_CANDIDATE_FOR_TYPES')) {
      return NextResponse.json({ error: 'No available asset matches your open roster slots' }, { status: 400 });
    }
    console.error('[draft/auto-pick] performAutoPick failed:', result.error);
    return NextResponse.json({ error: 'Auto-pick failed — please retry' }, { status: 500 });
  }

  // F5: cascade to any subsequent auto-draft users until a human's turn.
  let cascadeNextDrafterId: string | null = result.draftComplete ? null : result.nextDrafterId;
  let cascadeDraftComplete = result.draftComplete;

  if (cascadeNextDrafterId && !cascadeDraftComplete) {
    const cascade = await runAutoPickCascade(leagueId, cascadeNextDrafterId);
    cascadeDraftComplete = cascade.draftComplete;
    cascadeNextDrafterId = cascade.finalNextDrafterId;
    if (cascade.lastError) {
      console.error('[draft/auto-pick] cascade lastError:', cascade.lastError);
    }
  }

  const updatedSession = await DraftSession.findById(draftSession._id);
  if (!updatedSession) {
    return NextResponse.json({ error: 'Draft session disappeared' }, { status: 500 });
  }

  const nextDrafterId = cascadeDraftComplete ? null : cascadeNextDrafterId;

  // Push notifications based on FINAL post-cascade state. Mirrors /api/draft/pick.
  if (cascadeDraftComplete) {
    const allUserIds = updatedSession.draftOrder.map((id: any) => id.toString());
    sendPushToUsers(allUserIds, 'Draft complete! 🏁', 'Your team is set. Head to your paddock.', { screen: 'home', leagueId }, 'general').catch(() => {});
  } else if (nextDrafterId) {
    sendPushToUser(nextDrafterId, "You're on the clock! 🏎", 'Make your draft pick now.', { screen: 'draft', leagueId }, 'draft_turn').catch(() => {});
  }

  return NextResponse.json({
    ...updatedSession.toObject(),
    currentDrafterId: nextDrafterId,
  });
}
