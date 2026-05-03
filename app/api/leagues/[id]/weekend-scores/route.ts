/**
 * GET /api/leagues/[id]/weekend-scores
 *
 * Returns per-session weekend scores for the requesting user's roster assets
 * during the current active race weekend.
 *
 * "Active weekend" = the nearest RaceCalendar entry where raceDate >= now - 24h.
 * If the nearest race is more than 7 days away: returns { hasActiveWeekend: false }.
 *
 * Only sprint qualifying and sprint race points are broken out per-session.
 * Qualifying and race points are tracked in bulk via process-race-logic and will
 * be added in a future phase.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Roster, RaceCalendar } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { verifyLeagueMembership } from '@/lib/auth-helpers';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS    = 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: leagueId } = await params;
  const requestingUserId = (session.user as any).id as string;

  // Optional ?userId=X to view another manager's roster (auth still required)
  const targetUserId = req.nextUrl.searchParams.get('userId') ?? requestingUserId;

  await connectDB();

  if (!(await verifyLeagueMembership(leagueId, requestingUserId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const now = new Date();
  const lookbackCutoff = new Date(now.getTime() - ONE_DAY_MS);

  // Find the nearest upcoming (or just-completed) race
  const calendar = await RaceCalendar.findOne({
    season:   2026,
    cancelled: false,
    raceDate: { $gte: lookbackCutoff },
  })
    .sort({ raceDate: 1 })
    .lean() as any;

  if (!calendar) {
    return NextResponse.json({ hasActiveWeekend: false, reason: 'No upcoming races found' });
  }

  const msUntilRace = new Date(calendar.raceDate).getTime() - now.getTime();
  const daysUntilRace = msUntilRace / (24 * 60 * 60 * 1000);

  if (msUntilRace > SEVEN_DAYS_MS) {
    return NextResponse.json({
      hasActiveWeekend: false,
      nextRace: {
        name:         calendar.name,
        round:        calendar.round,
        raceDate:     calendar.raceDate,
        daysUntil:    Math.round(daysUntilRace * 10) / 10,
      },
    });
  }

  // Load the target user's roster (populated with asset slugs)
  const roster = await Roster.findOne({ leagueId, userId: targetUserId, season: 2026 })
    .populate('driver1AssetId',   'slug name team assetType')
    .populate('driver2AssetId',   'slug name team assetType')
    .populate('principalAssetId', 'slug name team assetType')
    .populate('pitCrew1AssetId',  'slug name team assetType')
    .populate('pitCrew2AssetId',  'slug name team assetType')
    .populate('powerUnitAssetId', 'slug name team assetType')
    .lean() as any;

  if (!roster) {
    return NextResponse.json({ error: 'Roster not found' }, { status: 404 });
  }

  // Build slug → points/position maps from all stored session results
  const sqPointsBySlug   = new Map<string, number>();
  const sqPositionBySlug = new Map<string, number>();
  if (Array.isArray(calendar.sprintQualiResults)) {
    for (const r of calendar.sprintQualiResults) {
      if (r.driverSlug) {
        sqPointsBySlug.set(r.driverSlug, r.points ?? 0);
        sqPositionBySlug.set(r.driverSlug, r.position ?? 0);
      }
    }
  }

  const srPointsBySlug   = new Map<string, number>();
  const srPositionBySlug = new Map<string, number>();
  if (Array.isArray(calendar.sprintRaceResults)) {
    for (const r of calendar.sprintRaceResults) {
      if (r.driverSlug) {
        srPointsBySlug.set(r.driverSlug, r.points ?? 0);
        srPositionBySlug.set(r.driverSlug, r.position ?? 0);
      }
    }
  }

  const qualPointsBySlug   = new Map<string, number>();
  const qualPositionBySlug = new Map<string, number>();
  if (Array.isArray(calendar.qualifyingResults)) {
    for (const r of calendar.qualifyingResults) {
      if (r.driverSlug) {
        qualPointsBySlug.set(r.driverSlug, r.points ?? 0);
        qualPositionBySlug.set(r.driverSlug, r.position ?? 0);
      }
    }
  }

  const racePointsBySlug   = new Map<string, number>();
  const racePositionBySlug = new Map<string, number>();
  if (Array.isArray(calendar.raceResults)) {
    for (const r of calendar.raceResults) {
      if (r.driverSlug) {
        racePointsBySlug.set(r.driverSlug, r.points ?? 0);
        racePositionBySlug.set(r.driverSlug, r.position ?? 0);
      }
    }
  }

  // Non-driver result maps (keyed by asset slug)
  const principalPointsBySlug = new Map<string, number>();
  if (Array.isArray(calendar.principalResults)) {
    for (const r of calendar.principalResults) {
      if (r.principalSlug) principalPointsBySlug.set(r.principalSlug, r.points ?? 0);
    }
  }

  const pitCrewPointsBySlug = new Map<string, number>();
  if (Array.isArray(calendar.pitCrewResults)) {
    for (const r of calendar.pitCrewResults) {
      if (r.pitCrewSlug) pitCrewPointsBySlug.set(r.pitCrewSlug, r.points ?? 0);
    }
  }

  const powerUnitPointsBySlug = new Map<string, number>();
  if (Array.isArray(calendar.powerUnitResults)) {
    for (const r of calendar.powerUnitResults) {
      if (r.powerUnitSlug) powerUnitPointsBySlug.set(r.powerUnitSlug, r.points ?? 0);
    }
  }

  // Build sessions list — sprint weekends have extra sessions
  function buildDriverSessions(slug: string | undefined) {
    const sessions: {
      key: string;
      name: string;
      points: number | null;
      scored: boolean;
      position: number | null;
      scheduledDate: Date | null;
    }[] = [];

    if (calendar.isSprint) {
      const sqFound = slug ? sqPointsBySlug.has(slug) : false;
      sessions.push({
        key:           'sprintQuali',
        name:          'Sprint Qualifying',
        scored:        sqFound,
        points:        sqFound && slug ? (sqPointsBySlug.get(slug) ?? 0) : null,
        position:      sqFound && slug ? (sqPositionBySlug.get(slug) ?? null) : null,
        scheduledDate: calendar.sprintQualifyingDate ?? null,
      });
      const srFound = slug ? srPointsBySlug.has(slug) : false;
      sessions.push({
        key:           'sprintRace',
        name:          'Sprint Race',
        scored:        srFound,
        points:        srFound && slug ? (srPointsBySlug.get(slug) ?? 0) : null,
        position:      srFound && slug ? (srPositionBySlug.get(slug) ?? null) : null,
        scheduledDate: calendar.sprintDate ?? null,
      });
    }

    const qualFound = slug ? qualPointsBySlug.has(slug) : false;
    sessions.push({
      key:           'qualifying',
      name:          'Qualifying',
      scored:        qualFound,
      points:        qualFound && slug ? (qualPointsBySlug.get(slug) ?? 0) : null,
      position:      qualFound && slug ? (qualPositionBySlug.get(slug) ?? null) : null,
      scheduledDate: calendar.qualifyingDate ?? null,
    });

    const raceFound = slug ? racePointsBySlug.has(slug) : false;
    sessions.push({
      key:           'race',
      name:          'Race',
      scored:        raceFound,
      points:        raceFound && slug ? (racePointsBySlug.get(slug) ?? 0) : null,
      position:      raceFound && slug ? (racePositionBySlug.get(slug) ?? null) : null,
      scheduledDate: calendar.raceDate ?? null,
    });

    return sessions;
  }

  function buildDriverScore(asset: any) {
    if (!asset) return null;
    const slug     = asset.slug as string;
    const sessions = buildDriverSessions(slug);
    const weekendPoints = sessions.reduce((sum, s) => sum + (s.points ?? 0), 0);
    return {
      slug,
      name:          asset.name,
      team:          asset.team,
      weekendPoints: Math.round(weekendPoints * 100) / 100,
      sessions,
    };
  }

  function buildNonDriverScore(
    asset: any,
    pointsMap: Map<string, number>,
  ) {
    if (!asset) return null;
    const slug    = asset.slug as string;
    const found   = pointsMap.has(slug);
    const points  = found ? (pointsMap.get(slug) ?? 0) : null;
    return {
      slug,
      name:           asset.name,
      team:           asset.team,
      weekendPoints:  Math.round((points ?? 0) * 100) / 100,
      hasWeekendData: found,
      sessions: [{
        key:           'race',
        name:          'Race',
        scored:        found,
        points,
        scheduledDate: calendar.raceDate ?? null,
      }],
    };
  }

  // Which sessions have been completed so far (scored = has result data in the array)
  const sessionsCompleted: string[] = [];
  const sessionsRemaining: string[] = [];
  const allSessions = calendar.isSprint
    ? ['sprintQuali', 'sprintRace', 'qualifying', 'race']
    : ['qualifying', 'race'];

  const scoredMap: Record<string, boolean> = {
    sprintQuali: sqPointsBySlug.size > 0,
    sprintRace:  srPointsBySlug.size > 0,
    qualifying:  qualPointsBySlug.size > 0,
    race:        racePointsBySlug.size > 0,
  };

  for (const key of allSessions) {
    (scoredMap[key] ? sessionsCompleted : sessionsRemaining).push(key);
  }

  const rosterScores = {
    driver1:   buildDriverScore(roster.driver1AssetId),
    driver2:   buildDriverScore(roster.driver2AssetId),
    principal: buildNonDriverScore(roster.principalAssetId, principalPointsBySlug),
    pitCrew1:  buildNonDriverScore(roster.pitCrew1AssetId,  pitCrewPointsBySlug),
    pitCrew2:  buildNonDriverScore(roster.pitCrew2AssetId,  pitCrewPointsBySlug),
    powerUnit: buildNonDriverScore(roster.powerUnitAssetId, powerUnitPointsBySlug),
  };

  return NextResponse.json({
    hasActiveWeekend:   true,
    raceName:           calendar.name,
    round:              calendar.round,
    isSprint:           calendar.isSprint,
    daysUntilRace:      Math.round(daysUntilRace * 10) / 10,
    sessionsCompleted,
    sessionsRemaining,
    rosterScores,
  });
}
