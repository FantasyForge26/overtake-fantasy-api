/**
 * GET  /api/leagues/[id]/trades       — list user's pending trades (incoming + outgoing)
 * POST /api/leagues/[id]/trades       — propose a new trade
 *
 * Trade flow: proposer picks own assets to send + counterparty assets to receive.
 * Server validates OTF balance (±10) and slot capacity (no side exceeds roster caps).
 * Counterparty then accepts or declines via /accept and /decline endpoints.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { Trade, Roster, Asset, User } from '@/lib/models';
import { verifyLeagueMembership } from '@/lib/auth-helpers';
import { validateTradeOTFBalance, validateTradeSlotCapacity, TradeAssetSummary } from '@/lib/trade-validation';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId } = await params;
  const userId = (session.user as any).id as string;

  await connectDB();
  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const trades = await Trade.find({
    leagueId,
    $or: [{ proposerUserId: userId }, { counterpartyUserId: userId }],
  })
    .sort({ proposedAt: -1 })
    .limit(50)
    .lean() as any[];

  // Enrich with display names for both sides
  const userIds = new Set<string>();
  for (const t of trades) {
    userIds.add(t.proposerUserId.toString());
    userIds.add(t.counterpartyUserId.toString());
  }
  const users = await User.find({ _id: { $in: Array.from(userIds) } }).select('displayName').lean() as any[];
  const nameByUserId = new Map(users.map(u => [u._id.toString(), u.displayName ?? 'Manager']));

  const enriched = trades.map(t => ({
    ...t,
    proposerName:    nameByUserId.get(t.proposerUserId.toString()) ?? 'Manager',
    counterpartyName: nameByUserId.get(t.counterpartyUserId.toString()) ?? 'Manager',
    direction:       t.proposerUserId.toString() === userId ? 'outgoing' : 'incoming',
  }));

  return NextResponse.json({ trades: enriched });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId } = await params;
  const userId = (session.user as any).id as string;

  await connectDB();
  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const { counterpartyUserId, fromAssetIds, toAssetIds, message } = body as {
    counterpartyUserId?: string;
    fromAssetIds?: string[];
    toAssetIds?: string[];
    message?: string;
  };

  if (!counterpartyUserId || counterpartyUserId === userId) {
    return NextResponse.json({ error: 'Invalid counterparty' }, { status: 400 });
  }
  if (!Array.isArray(fromAssetIds) || fromAssetIds.length === 0) {
    return NextResponse.json({ error: 'Must select at least one asset to send' }, { status: 400 });
  }
  if (!Array.isArray(toAssetIds) || toAssetIds.length === 0) {
    return NextResponse.json({ error: 'Must select at least one asset to receive' }, { status: 400 });
  }

  // Load both rosters with populated assets to validate ownership + collect OTF/type
  const [proposerRoster, counterpartyRoster] = await Promise.all([
    Roster.findOne({ leagueId, userId, season: 2026 }).lean() as any,
    Roster.findOne({ leagueId, userId: counterpartyUserId, season: 2026 }).lean() as any,
  ]);
  if (!proposerRoster) return NextResponse.json({ error: 'Your roster not found' }, { status: 404 });
  if (!counterpartyRoster) return NextResponse.json({ error: 'Counterparty roster not found' }, { status: 404 });

  const proposerAssetIds = collectRosterAssetIds(proposerRoster);
  const counterpartyAssetIds = collectRosterAssetIds(counterpartyRoster);

  // Verify the proposer owns every fromAssetId
  for (const id of fromAssetIds) {
    if (!proposerAssetIds.includes(id)) {
      return NextResponse.json({ error: `Asset ${id} is not on your roster` }, { status: 400 });
    }
  }
  for (const id of toAssetIds) {
    if (!counterpartyAssetIds.includes(id)) {
      return NextResponse.json({ error: `Asset ${id} is not on the counterparty's roster` }, { status: 400 });
    }
  }

  // Fetch asset details for OTF + type lookup
  const allAssetIds = [...fromAssetIds, ...toAssetIds];
  const assets = await Asset.find({ _id: { $in: allAssetIds } })
    .select('_id slug name assetType otfRating')
    .lean() as any[];
  const assetById = new Map(assets.map(a => [a._id.toString(), a]));

  const fromAssetSummaries: TradeAssetSummary[] = fromAssetIds.map(id => {
    const a = assetById.get(id);
    return { slug: a?.slug ?? '', otfRating: a?.otfRating ?? 0, assetType: a?.assetType };
  });
  const toAssetSummaries: TradeAssetSummary[] = toAssetIds.map(id => {
    const a = assetById.get(id);
    return { slug: a?.slug ?? '', otfRating: a?.otfRating ?? 0, assetType: a?.assetType };
  });

  // Validate OTF balance
  const otfCheck = validateTradeOTFBalance(fromAssetSummaries, toAssetSummaries);
  if (!otfCheck.valid) {
    return NextResponse.json({ error: otfCheck.reason, validation: 'otf', delta: otfCheck.delta }, { status: 400 });
  }

  // Validate slot capacity
  const slotCheck = validateTradeSlotCapacity(proposerRoster, counterpartyRoster, fromAssetSummaries, toAssetSummaries);
  if (!slotCheck.valid) {
    return NextResponse.json({ error: slotCheck.reason, validation: 'slots' }, { status: 400 });
  }

  // Build TradeAsset embedded docs
  const fromDocs = fromAssetIds.map(id => {
    const a = assetById.get(id);
    return {
      assetId:   a?._id,
      slug:      a?.slug,
      name:      a?.name,
      assetType: a?.assetType,
      otfRating: a?.otfRating ?? 0,
    };
  });
  const toDocs = toAssetIds.map(id => {
    const a = assetById.get(id);
    return {
      assetId:   a?._id,
      slug:      a?.slug,
      name:      a?.name,
      assetType: a?.assetType,
      otfRating: a?.otfRating ?? 0,
    };
  });

  const trade = await Trade.create({
    leagueId,
    season: 2026,
    proposerUserId: userId,
    counterpartyUserId,
    fromAssets:  fromDocs,
    toAssets:    toDocs,
    fromOtfTotal: otfCheck.fromTotal,
    toOtfTotal:   otfCheck.toTotal,
    status:      'pending',
    message:     message ?? '',
    proposedAt:  new Date(),
  });

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
