import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { Asset, League, Roster, WaiverBid } from '@/lib/models';

const WAIVER_TYPES = ['waivers', 'reverseStandings'];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = (session.user as any).id as string;
  const { id: leagueId } = await params;
  const { assetId, dropAssetId, bidAmount } = await req.json();

  if (!assetId) return NextResponse.json({ error: 'assetId is required' }, { status: 400 });
  if (bidAmount == null || typeof bidAmount !== 'number' || bidAmount < 0) {
    return NextResponse.json({ error: 'bidAmount must be >= 0' }, { status: 400 });
  }

  await connectDB();

  const league = await League.findById(leagueId).lean() as any;
  if (!league) return NextResponse.json({ error: 'League not found' }, { status: 404 });
  if (!WAIVER_TYPES.includes(league.acquisitionType)) {
    return NextResponse.json({ error: 'This league does not use waiver bidding' }, { status: 400 });
  }

  const asset = await Asset.findById(assetId).select('name assetType').lean() as any;
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const roster = await Roster.findOne({ leagueId, userId }).lean() as any;
  if (!roster) return NextResponse.json({ error: 'Roster not found' }, { status: 404 });

  if (bidAmount > (roster.ccBalance ?? 0)) {
    return NextResponse.json({ error: 'Bid exceeds available CC balance' }, { status: 400 });
  }

  // Check asset is not already rostered in the league
  const allRosters = await Roster.find({ leagueId }).lean() as any[];
  const allRosteredIds = allRosters.flatMap(r => [
    r.driver1AssetId, r.driver2AssetId, r.principalAssetId,
    r.pitCrew1AssetId, r.pitCrew2AssetId, r.powerUnitAssetId,
  ]).filter(Boolean).map((id: any) => id.toString());

  if (allRosteredIds.includes(assetId)) {
    return NextResponse.json({ error: 'Asset is already on a roster in this league' }, { status: 400 });
  }

  const bid = await WaiverBid.findOneAndUpdate(
    { leagueId, userId, assetId },
    { leagueId, userId, assetId, dropAssetId: dropAssetId ?? null, bidAmount, status: 'pending', createdAt: new Date() },
    { upsert: true, new: true },
  );

  return NextResponse.json({ bid });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = (session.user as any).id as string;
  const { id: leagueId } = await params;
  const { assetId } = await req.json();

  if (!assetId) return NextResponse.json({ error: 'assetId is required' }, { status: 400 });

  await connectDB();

  const result = await WaiverBid.findOneAndUpdate(
    { leagueId, userId, assetId, status: 'pending' },
    { status: 'cancelled' },
    { new: true },
  );

  if (!result) return NextResponse.json({ error: 'No pending bid found' }, { status: 404 });

  return NextResponse.json({ cancelled: true });
}
