import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Roster } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { verifyLeagueMembership } from '@/lib/auth-helpers';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

const ASSET_FIELDS = 'name team teamColor teamColorSecondary assetType carNumber nationality slug illustrationUrl otfRating otfComponents totalPoints avgPointsPerRace racesCompleted dnfCount podiums wins fastestStopCount avgPitStopTime avgFinishPosition age debutYear teammateName qualifyingRaces q2Count q3Count';

// M7 input validation constants for roster PATCH.
const MAX_TEAM_NAME_LEN = 50;
// Accept #RGB and #RRGGBB; case-insensitive. Empty string is allowed
// (clears the field).
const HEX_COLOR_RE = /^(#([A-Fa-f0-9]{3}|[A-Fa-f0-9]{6}))?$/;

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
  const targetUserId = req.nextUrl.searchParams.get('userId') ?? userId;

  await connectDB();

  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const roster = await Roster.findOne({ leagueId, userId: targetUserId })
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

  // 'write' preset (60/min per user). Roster customization is a rare action;
  // limit is mostly defense against scripted spam against the User collection.
  const rl = await checkRateLimit('write', `roster-update:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const { leagueId } = await params;
  const body = await req.json().catch(() => ({}));
  const { teamName, teamPrimaryColor, teamSecondaryColor, teamAccentColor } = body;

  if (!teamName || typeof teamName !== 'string' || !teamName.trim()) {
    return NextResponse.json({ error: 'teamName is required' }, { status: 400 });
  }
  const trimmedTeamName = teamName.trim();
  if (trimmedTeamName.length > MAX_TEAM_NAME_LEN) {
    return NextResponse.json(
      { error: `teamName exceeds ${MAX_TEAM_NAME_LEN} characters` },
      { status: 400 },
    );
  }

  // Color fields, if provided, must be empty string or a 3/6-digit hex color.
  // Without this they were free-form strings — a 1MB blob would store, break
  // the mobile renderer, and bloat the leaderboard payload.
  for (const [label, val] of [
    ['teamPrimaryColor',   teamPrimaryColor],
    ['teamSecondaryColor', teamSecondaryColor],
    ['teamAccentColor',    teamAccentColor],
  ] as const) {
    if (val === undefined) continue;
    if (typeof val !== 'string' || !HEX_COLOR_RE.test(val)) {
      return NextResponse.json(
        { error: `${label} must be a hex color like #RRGGBB (or empty)` },
        { status: 400 },
      );
    }
  }

  await connectDB();

  const update: Record<string, any> = { teamName: trimmedTeamName, updatedAt: new Date() };
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
