/**
 * POST /api/leagues/[id]/trades/[tradeId]/accept
 *
 * Counterparty accepts a pending trade. Executes the asset swap atomically:
 * removes traded assets from each roster's slots, fills slots with the
 * incoming assets, then marks the trade accepted.
 *
 * Re-validates OTF + slot capacity at accept time because the rosters may
 * have changed since the proposal was made (e.g. another trade went through).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { Trade, Roster } from '@/lib/models';
import { validateTradeOTFBalance, validateTradeSlotCapacity, TradeAssetSummary } from '@/lib/trade-validation';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; tradeId: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId, tradeId } = await params;
  const userId = (session.user as any).id as string;

  // 'write' preset (60/min per user). Trade accepts mutate two rosters atomically;
  // limit prevents accept-spam abuse and reduces risk of concurrent-accept races.
  const rl = await checkRateLimit('write', `trade-accept:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  await connectDB();

  const trade = await Trade.findById(tradeId) as any;
  if (!trade) return NextResponse.json({ error: 'Trade not found' }, { status: 404 });
  if (trade.leagueId.toString() !== leagueId) return NextResponse.json({ error: 'League mismatch' }, { status: 400 });
  if (trade.counterpartyUserId.toString() !== userId) {
    return NextResponse.json({ error: 'Only the counterparty can accept this trade' }, { status: 403 });
  }
  if (trade.status !== 'pending') {
    return NextResponse.json({ error: `Trade is already ${trade.status}` }, { status: 400 });
  }

  // Re-validate against current rosters (rosters may have changed since proposal)
  const [proposerRoster, counterpartyRoster] = await Promise.all([
    Roster.findOne({ leagueId, userId: trade.proposerUserId, season: 2026 }),
    Roster.findOne({ leagueId, userId,                       season: 2026 }),
  ]);
  if (!proposerRoster || !counterpartyRoster) {
    return NextResponse.json({ error: 'Roster not found' }, { status: 404 });
  }

  const fromSummaries: TradeAssetSummary[] = (trade.fromAssets as any[]).map(a => ({
    slug: a.slug, otfRating: a.otfRating, assetType: a.assetType,
  }));
  const toSummaries: TradeAssetSummary[] = (trade.toAssets as any[]).map(a => ({
    slug: a.slug, otfRating: a.otfRating, assetType: a.assetType,
  }));

  const otfCheck = validateTradeOTFBalance(fromSummaries, toSummaries);
  if (!otfCheck.valid) {
    return NextResponse.json({ error: 'Trade is no longer valid: ' + otfCheck.reason }, { status: 400 });
  }
  const slotCheck = validateTradeSlotCapacity(proposerRoster, counterpartyRoster, fromSummaries, toSummaries);
  if (!slotCheck.valid) {
    return NextResponse.json({ error: 'Trade is no longer valid: ' + slotCheck.reason }, { status: 400 });
  }

  // Verify both sides still own the assets they're trading
  const proposerOwns = collectRosterAssetIds(proposerRoster);
  const counterpartyOwns = collectRosterAssetIds(counterpartyRoster);

  for (const a of trade.fromAssets) {
    if (!proposerOwns.includes(a.assetId.toString())) {
      return NextResponse.json({ error: `Proposer no longer owns ${a.name ?? a.slug}` }, { status: 400 });
    }
  }
  for (const a of trade.toAssets) {
    if (!counterpartyOwns.includes(a.assetId.toString())) {
      return NextResponse.json({ error: `Counterparty no longer owns ${a.name ?? a.slug}` }, { status: 400 });
    }
  }

  // Execute the swap
  swapAssetsOnRosters(
    proposerRoster,
    counterpartyRoster,
    trade.fromAssets,
    trade.toAssets,
  );

  await Promise.all([
    proposerRoster.save(),
    counterpartyRoster.save(),
  ]);

  trade.status = 'accepted';
  trade.respondedAt = new Date();
  await trade.save();

  return NextResponse.json({ trade });
}

function collectRosterAssetIds(roster: any): string[] {
  return [
    roster.driver1AssetId,
    roster.driver2AssetId,
    roster.principalAssetId,
    roster.pitCrew1AssetId,
    roster.pitCrew2AssetId,
    roster.powerUnitAssetId,
  ].filter(Boolean).map((id: any) => id.toString());
}

/**
 * Atomically swaps the traded assets between the two rosters' slot fields.
 * Removes fromAssets from proposer and toAssets from counterparty, then fills
 * each side's slot fields with the incoming assets (matching by assetType).
 */
function swapAssetsOnRosters(
  proposer: any,
  counterparty: any,
  fromAssets: any[],   // proposer → counterparty
  toAssets: any[],     // counterparty → proposer
) {
  // Clear traded slots on proposer side
  for (const a of fromAssets) {
    clearAssetFromRoster(proposer, a.assetId);
  }
  // Clear traded slots on counterparty side
  for (const a of toAssets) {
    clearAssetFromRoster(counterparty, a.assetId);
  }
  // Fill proposer with incoming assets
  for (const a of toAssets) {
    fillAssetIntoRoster(proposer, a.assetId, a.assetType);
  }
  // Fill counterparty with incoming assets
  for (const a of fromAssets) {
    fillAssetIntoRoster(counterparty, a.assetId, a.assetType);
  }
  proposer.updatedAt = new Date();
  counterparty.updatedAt = new Date();
}

function clearAssetFromRoster(roster: any, assetId: any) {
  const idStr = assetId.toString();
  for (const field of [
    'driver1AssetId', 'driver2AssetId', 'principalAssetId',
    'pitCrew1AssetId', 'pitCrew2AssetId', 'powerUnitAssetId',
  ]) {
    if (roster[field]?.toString() === idStr) {
      roster[field] = undefined;
      return;
    }
  }
}

function fillAssetIntoRoster(roster: any, assetId: any, assetType: string) {
  switch (assetType) {
    case 'driver':
      if (!roster.driver1AssetId) roster.driver1AssetId = assetId;
      else                         roster.driver2AssetId = assetId;
      return;
    case 'principal':
      roster.principalAssetId = assetId;
      return;
    case 'pitCrew':
      if (!roster.pitCrew1AssetId) roster.pitCrew1AssetId = assetId;
      else                          roster.pitCrew2AssetId = assetId;
      return;
    case 'powerUnit':
      roster.powerUnitAssetId = assetId;
      return;
  }
}
