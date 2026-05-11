import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Asset, DraftSession, DraftQueue, League, Roster } from '@/lib/models';
import { sendPushToUser, sendPushToUsers } from '@/lib/push';
import { atomicClaimAsset, assignRosterSlot, assertAssetNotOnAnyRoster, rollbackClaim, nextNeededAssetType, neededAssetTypes, sortCandidatesForAutoDraft } from '@/lib/pick-helpers';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const querySecret = req.nextUrl.searchParams.get('secret');
  const secret = process.env.CRON_SECRET;
  if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();
  const activeSessions = await DraftSession.find({ status: 'active' });
  const now = Date.now();
  let processed = 0;

  for (const draftSession of activeSessions) {
    let userId = draftSession.draftOrder[draftSession.currentPickIndex]?.toString();
    if (!userId) continue;

    const isAutoDraft = draftSession.autoDraftUserIds?.includes(userId) ?? false;

    // If user is in auto-draft, force pick immediately (treat as expired 4s ago)
    // Otherwise check if timer has expired normally
    if (!isAutoDraft) {
      const expiresAt =
        new Date(draftSession.currentPickStartedAt).getTime() +
        draftSession.pickTimeLimitSeconds * 1000;
      if (now < expiresAt) continue;
    }

    const leagueId = draftSession.leagueId.toString();
    let roster = await Roster.findOne({ leagueId, userId });
    if (!roster) continue;

    let neededType = nextNeededAssetType(roster, draftSession.currentRound, draftSession.totalRounds);

    while (!neededType && draftSession.currentPickIndex < draftSession.draftOrder.length - 1) {
      draftSession.currentPickIndex += 1;
      const nextDrafterId = draftSession.draftOrder[draftSession.currentPickIndex];
      const nextRoster = await Roster.findOne({
        leagueId: draftSession.leagueId,
        userId: nextDrafterId,
      });
      if (!nextRoster) break;
      userId = nextDrafterId.toString();
      roster = nextRoster;
      neededType = nextNeededAssetType(nextRoster, draftSession.currentRound, draftSession.totalRounds);
    }

    if (!neededType) {
      // All rosters full — mark draft completed
      draftSession.status = 'completed';
      draftSession.completedAt = new Date();
      draftSession.currentPickIndex = draftSession.draftOrder.length;
      await draftSession.save();
      await League.updateOne(
        { _id: draftSession.leagueId },
        { $set: { status: 'active' } },
      );
      processed++;
      continue;
    }

    // Re-fetch session from DB in case the while loop advanced the in-memory index
    // past full rosters (the DB still holds the original index at this point)
    const freshSession = await DraftSession.findById(draftSession._id);
    if (!freshSession || freshSession.status !== 'active') continue;

    const availableIds = freshSession.availableAssetIds.map((id: any) => id.toString());

    // All asset types the roster still needs — drives a multi-type query so
    // auto-draft picks the highest OTF asset across ALL open slots, not just
    // the single neededType slot.
    const openTypes = neededAssetTypes(roster);

    // Check queue first — pick the first queued asset whose type fills an open slot
    const draftQueue = await DraftQueue.findOne({ leagueId, userId });
    const queuedIds = draftQueue?.queue?.map((id: any) => id.toString()) ?? [];
    const queuedPickId = queuedIds.find((qid: string) => availableIds.includes(qid));

    let bestAsset: any = null;
    if (queuedPickId) {
      const queued = await Asset.findOne({
        _id: queuedPickId,
        assetType: { $in: openTypes },
        isActive: true,
      }).select('_id assetType');
      if (queued) bestAsset = queued;
    }

    // Fall back to highest-tier asset, then highest OTF within the tier.
    // Driver > Principal > PitCrew > PowerUnit reflects raw fantasy points per
    // race — prevents auto-draft from "wasting" early picks on a high-rated
    // low-tier asset when stronger drivers are still on the board.
    if (!bestAsset) {
      const candidates = await Asset
        .find({ _id: { $in: availableIds }, assetType: { $in: openTypes }, isActive: true })
        .select('_id assetType otfRating')
        .lean();
      bestAsset = sortCandidatesForAutoDraft(candidates as any[])[0] ?? null;
    }

    if (!bestAsset) continue;

    const assetType = bestAsset.assetType as string;
    const memberCount = freshSession.draftOrder.length / freshSession.totalRounds;
    const pickIndex = freshSession.currentPickIndex;
    const newPickIndex = pickIndex + 1;
    const newRound = Math.floor(newPickIndex / memberCount) + 1;

    // Mark user as auto-draft before claiming
    if (!freshSession.autoDraftUserIds) freshSession.autoDraftUserIds = [];
    if (!freshSession.autoDraftUserIds.includes(userId)) {
      freshSession.autoDraftUserIds.push(userId);
      freshSession.markModified('autoDraftUserIds');
      await freshSession.save();
    }

    const updatedSession = await atomicClaimAsset({
      sessionId: freshSession._id,
      assetId: bestAsset._id,
      pickIndex,
      newPickIndex,
      newRound,
      pickDoc: {
        pickNumber: pickIndex + 1,
        round: freshSession.currentRound,
        userId,
        assetId: bestAsset._id,
        assetType,
        pickedAt: new Date(),
      },
    });

    if (!updatedSession) continue; // lost the race — next cron run will handle it

    try {
      await assertAssetNotOnAnyRoster(leagueId, bestAsset._id);
    } catch (err) {
      console.error('[cron/auto-pick] assertAssetNotOnAnyRoster failed:', err);
      await rollbackClaim(updatedSession._id, bestAsset._id);
      continue; // next cron run will pick a different asset
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

    processed++;

    // Push notifications
    if (updatedSession.status === 'completed') {
      const allUserIds = updatedSession.draftOrder.map((id: any) => id.toString());
      sendPushToUsers(allUserIds, 'Draft complete! 🏁', 'Your team is set. Head to your paddock.', { screen: 'home', leagueId }, 'general').catch(() => {});
    } else {
      const nextUserId = updatedSession.draftOrder[updatedSession.currentPickIndex]?.toString();
      if (nextUserId) {
        sendPushToUser(nextUserId, "You're on the clock! 🏎", 'Make your draft pick now.', { screen: 'draft', leagueId }, 'draft_turn').catch(() => {});
      }
    }
  }

  return NextResponse.json({ processed });
}
