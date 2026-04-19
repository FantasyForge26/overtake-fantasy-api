import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Roster, User } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

const ASSET_SELECT = 'name assetType totalPoints avgPointsPerRace otfRating teamColor carNumber team manufacturer';

function pickAssetFields(asset: any) {
  if (!asset) return null;
  return {
    name:             asset.name,
    totalPoints:      asset.totalPoints ?? 0,
    avgPointsPerRace: asset.avgPointsPerRace ?? 0,
    otfRating:        asset.otfRating ?? 50,
    teamColor:        asset.teamColor ?? '#FFFFFF',
    team:             asset.team ?? null,
    ...(asset.manufacturer != null ? { manufacturer: asset.manufacturer } : {}),
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: leagueId } = await params;

  await connectDB();

  const rosters = await Roster.find({ leagueId, season: 2026 })
    .populate('driver1AssetId',    ASSET_SELECT)
    .populate('driver2AssetId',    ASSET_SELECT)
    .populate('principalAssetId',  ASSET_SELECT)
    .populate('pitCrew1AssetId',   ASSET_SELECT)
    .populate('pitCrew2AssetId',   ASSET_SELECT)
    .populate('powerUnitAssetId',  ASSET_SELECT)
    .lean() as any[];

  // Batch-load all users
  const userIds = [...new Set(rosters.map(r => r.userId?.toString()).filter(Boolean))];
  const users   = await User.find({ _id: { $in: userIds } }).select('displayName avatarUrl').lean() as any[];
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  const entries = rosters.map(roster => {
    const user = userMap.get(roster.userId?.toString() ?? '');

    const drivers   = [roster.driver1AssetId, roster.driver2AssetId].filter(Boolean).map(pickAssetFields);
    const pitCrews  = [roster.pitCrew1AssetId, roster.pitCrew2AssetId].filter(Boolean).map(pickAssetFields);
    const principal = pickAssetFields(roster.principalAssetId ?? null);
    const powerUnit = pickAssetFields(roster.powerUnitAssetId ?? null);

    return {
      userId:       roster.userId?.toString() ?? '',
      displayName:  user?.displayName ?? 'Unknown',
      avatarUrl:    user?.avatarUrl ?? null,
      isAI:         roster.isAI ?? false,
      teamName:     roster.teamName ?? '',
      totalPoints:  roster.totalPoints ?? 0,
      roster: { drivers, principal, pitCrews, powerUnit },
    };
  });

  entries.sort((a, b) => b.totalPoints - a.totalPoints);

  const leaderboard = entries.map((entry, i) => ({ rank: i + 1, ...entry }));

  return NextResponse.json(leaderboard);
}
