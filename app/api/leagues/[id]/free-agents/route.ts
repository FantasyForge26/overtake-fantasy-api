import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Roster, Asset } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: leagueId } = await params;
  const assetType = req.nextUrl.searchParams.get('assetType');

  await connectDB();

  const rosters = await Roster.find({ leagueId }).lean() as any[];

  const assignedIds = new Set<string>();
  for (const roster of rosters) {
    for (const field of ['driver1AssetId', 'driver2AssetId', 'principalAssetId', 'pitCrew1AssetId', 'pitCrew2AssetId', 'powerUnitAssetId']) {
      if (roster[field]) assignedIds.add(roster[field].toString());
    }
  }

  const filter: Record<string, any> = {
    season: 2026,
    confirmed: true,
    _id: { $nin: Array.from(assignedIds) },
  };
  if (assetType) filter.assetType = assetType;

  const assets = await Asset.find(filter).sort({ otfRating: -1 });

  return NextResponse.json(assets);
}
