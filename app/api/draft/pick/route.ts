import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Asset, DraftSession, League, Roster } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { sendPushToUser, sendPushToUsers } from '@/lib/push';
import { atomicClaimAsset, assignRosterSlot, assertAssetNotOnAnyRoster, rollbackClaim } from '@/lib/pick-helpers';
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

  // 'write' preset (60/min per user). One pick per second is far above any
  // legitimate draft cadence (snake drafts have ≥60s pick timers). The draft
  // state machine already rejects out-of-turn picks; this limit prevents a
  // misbehaving client from hammering the endpoint between turns.
  const rl = await checkRateLimit('write', `draft-pick:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

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

  const pickIndex = draftSession.currentPickIndex;
  const memberCount = draftSession.draftOrder.length / draftSession.totalRounds;
  const newPickIndex = pickIndex + 1;
  const newRound = Math.floor(newPickIndex / memberCount) + 1;

  const updatedSession = await atomicClaimAsset({
    sessionId: draftSession._id,
    assetId: asset._id,
    pickIndex,
    newPickIndex,
    newRound,
    pickDoc: {
      pickNumber: pickIndex + 1,
      round: draftSession.currentRound,
      userId,
      assetId: asset._id,
      assetType,
      pickedAt: new Date(),
    },
  });

  if (!updatedSession) {
    return NextResponse.json({ error: 'Asset already taken — please pick again' }, { status: 409 });
  }

  try {
    await assertAssetNotOnAnyRoster(leagueId, asset._id);
  } catch (err) {
    console.error('[draft/pick] assertAssetNotOnAnyRoster failed:', err);
    await rollbackClaim(updatedSession._id, asset._id);
    return NextResponse.json({ error: 'Asset already on a roster — please pick again' }, { status: 409 });
  }

  await assignRosterSlot(leagueId, userId, asset._id, assetType);

  // Check if draft is complete
  if (updatedSession.currentPickIndex >= updatedSession.totalPicks) {
    updatedSession.status = 'completed';
    updatedSession.completedAt = new Date();
    const league = await League.findById(leagueId);
    if (league) {
      league.status = 'active';
      await league.save();
    }
    await updatedSession.save();
  }

  const nextDrafterId =
    updatedSession.status === 'completed'
      ? null
      : updatedSession.draftOrder[updatedSession.currentPickIndex]?.toString() ?? null;

  // Push notifications (fire and forget)
  if (updatedSession.status === 'completed') {
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
