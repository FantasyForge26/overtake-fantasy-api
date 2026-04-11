import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Asset, League, Roster, Transaction, WaiverBid } from '@/lib/models';
import { sendPushToUser } from '@/lib/push';

const WAIVER_TYPES = ['waivers', 'reverseStandings'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const SLOT_MAP: Record<string, string[]> = {
  driver:    ['driver1AssetId', 'driver2AssetId'],
  principal: ['principalAssetId'],
  pitCrew:   ['pitCrew1AssetId', 'pitCrew2AssetId'],
  powerUnit: ['powerUnitAssetId'],
};

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const querySecret = req.nextUrl.searchParams.get('secret');
  const secret = process.env.CRON_SECRET;
  if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const todayDay = DAY_NAMES[new Date().getDay()];

  const leagues = await League.find({
    status: 'active',
    acquisitionType: { $in: WAIVER_TYPES },
    waiversClearDay: todayDay,
  }).lean() as any[];

  let processed = 0;

  for (const league of leagues) {
    const leagueId = league._id.toString();

    // Get all pending bids for this league
    const pendingBids = await WaiverBid.find({ leagueId, status: 'pending' }).lean() as any[];
    if (pendingBids.length === 0) continue;

    // Get all rosters for tiebreaker (lower totalPoints = higher priority)
    const rosters = await Roster.find({ leagueId }).lean() as any[];
    const rosterByUser = new Map(rosters.map((r: any) => [r.userId.toString(), r]));

    // Group bids by assetId
    const byAsset = new Map<string, any[]>();
    for (const bid of pendingBids) {
      const key = bid.assetId.toString();
      if (!byAsset.has(key)) byAsset.set(key, []);
      byAsset.get(key)!.push(bid);
    }

    // Track which assets have been won (so same asset can't be won twice)
    const wonAssets = new Set<string>();

    // Sort assets consistently (process all assets, pick winners)
    for (const [assetId, bids] of byAsset.entries()) {
      if (wonAssets.has(assetId)) continue;

      // Check asset still not on any roster (could have been added via other means)
      const allRosteredIds = rosters.flatMap((r: any) => [
        r.driver1AssetId, r.driver2AssetId, r.principalAssetId,
        r.pitCrew1AssetId, r.pitCrew2AssetId, r.powerUnitAssetId,
      ]).filter(Boolean).map((id: any) => id.toString());

      if (allRosteredIds.includes(assetId)) {
        // Mark all bids for this asset as lost
        await WaiverBid.updateMany({ leagueId, assetId, status: 'pending' }, { status: 'lost', processedAt: new Date() });
        continue;
      }

      // Sort: highest bid first; tie = lowest totalPoints (worse record = higher priority)
      bids.sort((a: any, b: any) => {
        if (b.bidAmount !== a.bidAmount) return b.bidAmount - a.bidAmount;
        const aPoints = rosterByUser.get(a.userId.toString())?.totalPoints ?? 0;
        const bPoints = rosterByUser.get(b.userId.toString())?.totalPoints ?? 0;
        return aPoints - bPoints; // lower points = higher priority
      });

      const winner = bids[0];
      const losers = bids.slice(1);
      const winnerId = winner.userId.toString();

      const asset = await Asset.findById(assetId).select('name assetType').lean() as any;
      if (!asset) {
        await WaiverBid.updateMany({ leagueId, assetId, status: 'pending' }, { status: 'lost', processedAt: new Date() });
        continue;
      }

      // Update winner's roster
      const winnerRoster = await Roster.findOne({ leagueId, userId: winnerId });
      if (!winnerRoster) {
        await WaiverBid.updateMany({ leagueId, assetId, status: 'pending' }, { status: 'lost', processedAt: new Date() });
        continue;
      }

      const slots = SLOT_MAP[asset.assetType] ?? [];

      // Drop asset if specified
      if (winner.dropAssetId) {
        const dropId = winner.dropAssetId.toString();
        for (const slot of Object.values(SLOT_MAP).flat()) {
          if (winnerRoster[slot]?.toString() === dropId) {
            winnerRoster[slot] = undefined;
            break;
          }
        }
        await Transaction.create({ leagueId, userId: winnerId, type: 'drop', dropAssetId: winner.dropAssetId, createdAt: new Date() });
      }

      // Assign to open slot
      const openSlot = slots.find(slot => !winnerRoster[slot]) ?? slots[0];
      if (openSlot) {
        winnerRoster[openSlot] = assetId;
        winnerRoster.ccBalance = Math.max(0, (winnerRoster.ccBalance ?? 0) - winner.bidAmount);
        winnerRoster.updatedAt = new Date();
        await winnerRoster.save();

        await Transaction.create({ leagueId, userId: winnerId, type: 'waiver', addAssetId: assetId, dropAssetId: winner.dropAssetId ?? undefined, note: `Waiver claim — bid: ${winner.bidAmount} CC`, createdAt: new Date() });

        wonAssets.add(assetId);
        await WaiverBid.findByIdAndUpdate(winner._id, { status: 'won', processedAt: new Date() });

        sendPushToUser(winnerId, '🎉 Waiver claim won!', `${asset.name} is now on your team.`, { screen: 'home', leagueId }, 'general').catch(() => {});
      }

      // Mark losers
      for (const loser of losers) {
        await WaiverBid.findByIdAndUpdate(loser._id, { status: 'lost', processedAt: new Date() });
        sendPushToUser(loser.userId.toString(), 'Waiver claim lost', `Your claim for ${asset.name} was unsuccessful.`, { screen: 'home', leagueId }, 'general').catch(() => {});
      }

      processed++;
    }
  }

  return NextResponse.json({ processed });
}
