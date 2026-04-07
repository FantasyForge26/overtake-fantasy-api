import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Roster } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

const ASSET_FIELDS = 'name team teamColor teamColorSecondary assetType carNumber nationality slug';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ leagueId: string }> },
) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { leagueId } = await params;

  await connectDB();

  const roster = await Roster.findOne({ leagueId, userId })
    .populate('driver1AssetId', ASSET_FIELDS)
    .populate('driver2AssetId', ASSET_FIELDS)
    .populate('principalAssetId', ASSET_FIELDS)
    .populate('pitCrew1AssetId', ASSET_FIELDS)
    .populate('pitCrew2AssetId', ASSET_FIELDS)
    .populate('powerUnitAssetId', ASSET_FIELDS);

  if (!roster) {
    return NextResponse.json({ error: 'Roster not found' }, { status: 404 });
  }

  return NextResponse.json(roster);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ leagueId: string }> },
) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { leagueId } = await params;
  const body = await req.json();
  const { teamName, teamPrimaryColor, teamSecondaryColor, teamAccentColor } = body;

  if (!teamName || typeof teamName !== 'string' || !teamName.trim()) {
    return NextResponse.json({ error: 'teamName is required' }, { status: 400 });
  }

  await connectDB();

  const update: Record<string, any> = { teamName: teamName.trim(), updatedAt: new Date() };
  if (teamPrimaryColor !== undefined)   update.teamPrimaryColor   = teamPrimaryColor;
  if (teamSecondaryColor !== undefined) update.teamSecondaryColor = teamSecondaryColor;
  if (teamAccentColor !== undefined)    update.teamAccentColor    = teamAccentColor;

  const roster = await Roster.findOneAndUpdate(
    { leagueId, userId },
    update,
    { new: true },
  )
    .populate('driver1AssetId', ASSET_FIELDS)
    .populate('driver2AssetId', ASSET_FIELDS)
    .populate('principalAssetId', ASSET_FIELDS)
    .populate('pitCrew1AssetId', ASSET_FIELDS)
    .populate('pitCrew2AssetId', ASSET_FIELDS)
    .populate('powerUnitAssetId', ASSET_FIELDS);

  if (!roster) {
    return NextResponse.json({ error: 'Roster not found' }, { status: 404 });
  }

  return NextResponse.json(roster);
}
