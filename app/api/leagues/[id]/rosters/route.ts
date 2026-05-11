/**
 * GET /api/leagues/[id]/rosters
 *
 * Returns all rosters in the league with their assets populated. Used by the
 * trade creator UI to let the proposer pick a counterparty and browse their
 * paddock.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { Roster, User } from '@/lib/models';
import { verifyLeagueMembership } from '@/lib/auth-helpers';

const ASSET_FIELDS = 'name team teamColor teamColorSecondary assetType carNumber nationality slug illustrationUrl otfRating otfComponents totalPoints avgPointsPerRace';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId } = await params;
  const userId = (session.user as any).id as string;

  await connectDB();
  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const rosters = await Roster.find({ leagueId, season: 2026 })
    .populate('driver1AssetId',   ASSET_FIELDS)
    .populate('driver2AssetId',   ASSET_FIELDS)
    .populate('principalAssetId', ASSET_FIELDS)
    .populate('pitCrew1AssetId',  ASSET_FIELDS)
    .populate('pitCrew2AssetId',  ASSET_FIELDS)
    .populate('powerUnitAssetId', ASSET_FIELDS)
    .lean() as any[];

  // Enrich with display names + isMe flag
  const userIds = rosters.map(r => r.userId);
  const users = await User.find({ _id: { $in: userIds } }).select('displayName isAI').lean() as any[];
  const userById = new Map(users.map(u => [u._id.toString(), u]));

  const out = rosters.map(r => {
    const uid = r.userId?.toString();
    const u = uid ? userById.get(uid) : null;
    return {
      _id:           r._id,
      userId:        uid,
      teamName:      r.teamName ?? 'My Team',
      teamPrimaryColor: r.teamPrimaryColor ?? '#FFFFFF',
      displayName:   u?.displayName ?? 'Manager',
      isAI:          u?.isAI ?? false,
      isMe:          uid === userId,
      totalPoints:   r.totalPoints ?? 0,
      seasonRank:    r.seasonRank ?? null,
      driver1:    r.driver1AssetId   ?? null,
      driver2:    r.driver2AssetId   ?? null,
      principal:  r.principalAssetId ?? null,
      pitCrew1:   r.pitCrew1AssetId  ?? null,
      pitCrew2:   r.pitCrew2AssetId  ?? null,
      powerUnit:  r.powerUnitAssetId ?? null,
    };
  });

  return NextResponse.json({ rosters: out });
}
