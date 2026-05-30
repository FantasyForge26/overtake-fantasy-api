import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Asset, DraftSession, DraftQueue, League, Roster } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { atomicClaimAsset, assignRosterSlot, assertAssetNotOnAnyRoster, rollbackClaim, nextNeededAssetType, neededAssetTypes, sortCandidatesForAutoDraft } from '@/lib/pick-helpers';
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

  const openTypes = neededAssetTypes(roster);
  if (openTypes.length === 0) return NextResponse.json({ error: 'Roster is already full' }, { status: 400 });

  const availableIds = draftSession.availableAssetIds.map((id: any) => id.toString());

  // Check queue first — use the first queued asset that is available and matches an open slot
  const draftQueue = await DraftQueue.findOne({ leagueId, userId });
  const queuedIds = draftQueue?.queue?.map((id: any) => id.toString()) ?? [];
  const queuedPickId = queuedIds.find((qid: string) => availableIds.includes(qid));

  let bestAsset: any = null;
  if (queuedPickId) {
    const queued = await Asset.findOne({ _id: queuedPickId, assetType: { $in: openTypes }, isActive: true }).select('_id assetType');
    if (queued) bestAsset = queued;
  }

  // Fall back to highest-tier asset, then highest OTF within the tier
  if (!bestAsset) {
    const candidates = await Asset
      .find({ _id: { $in: availableIds }, assetType: { $in: openTypes }, isActive: true })
      .select('_id assetType otfRating')
      .lean();
    bestAsset = sortCandidatesForAutoDraft(candidates as any[])[0] ?? null;
  }

  if (!bestAsset) {
    return NextResponse.json({ error: `No available asset found for open slots: ${openTypes.join(', ')}` }, { status: 400 });
  }

  const assetType = bestAsset.assetType as string;

  const pickIndex = draftSession.currentPickIndex;
  const memberCount = draftSession.draftOrder.length / draftSession.totalRounds;
  const newPickIndex = pickIndex + 1;
  const newRound = Math.floor(newPickIndex / memberCount) + 1;

  // Mark user as auto-draft before claiming
  if (!draftSession.autoDraftUserIds) draftSession.autoDraftUserIds = [];
  if (!draftSession.autoDraftUserIds.includes(userId)) {
    draftSession.autoDraftUserIds.push(userId);
    await draftSession.save();
  }

  const updatedSession = await atomicClaimAsset({
    sessionId: draftSession._id,
    assetId: bestAsset._id,
    pickIndex,
    newPickIndex,
    newRound,
    pickDoc: {
      pickNumber: pickIndex + 1,
      round: draftSession.currentRound,
      userId,
      assetId: bestAsset._id,
      assetType,
      pickedAt: new Date(),
    },
  });

  if (!updatedSession) {
    return NextResponse.json({ error: 'Pick slot already taken — please retry' }, { status: 409 });
  }

  try {
    await assertAssetNotOnAnyRoster(leagueId, bestAsset._id);
  } catch (err) {
    console.error('[draft/auto-pick] assertAssetNotOnAnyRoster failed:', err);
    await rollbackClaim(updatedSession._id, bestAsset._id);
    return NextResponse.json({ error: 'Asset already on a roster — please retry' }, { status: 409 });
  }

  await assignRosterSlot(leagueId, userId, bestAsset._id, assetType);

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

  return NextResponse.json({
    ...updatedSession.toObject(),
    currentDrafterId: nextDrafterId,
  });
}
