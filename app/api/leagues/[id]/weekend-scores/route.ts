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
  const userId = (session.user as any).id as string;

  await connectDB();

  if (!(await verifyLeagueMembership(leagueId, userId))) {
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

  // Load the user's roster (populated with asset slugs)
  const roster = await Roster.findOne({ leagueId, userId, season: 2026 })
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

  // Build slug → points maps from calendar's stored sprint results
  const sqPointsBySlug  = new Map<string, number>();
  const sqPositionBySlug = new Map<string, number>();
  if (calendar.sprintQualiScored && Array.isArray(calendar.sprintQualiResults)) {
    for (const r of calendar.sprintQualiResults) {
      if (r.driverSlug) {
        sqPointsBySlug.set(r.driverSlug, r.points ?? 0);
        sqPositionBySlug.set(r.driverSlug, r.position ?? 0);
      }
    }
  }

  const srPointsBySlug   = new Map<string, number>();
  const srPositionBySlug = new Map<string, number>();
  if (calendar.sprintRaceScored && Array.isArray(calendar.sprintRaceResults)) {
    for (const r of calendar.sprintRaceResults) {
      if (r.driverSlug) {
        srPointsBySlug.set(r.driverSlug, r.points ?? 0);
        srPositionBySlug.set(r.driverSlug, r.position ?? 0);
      }
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
      sessions.push({
        key:           'sprintQuali',
        name:          'Sprint Qualifying',
        scored:        !!calendar.sprintQualiScored,
        points:        slug && calendar.sprintQualiScored ? (sqPointsBySlug.get(slug) ?? 0) : null,
        position:      slug && calendar.sprintQualiScored ? (sqPositionBySlug.get(slug) ?? null) : null,
        scheduledDate: calendar.sprintQualifyingDate ?? null,
      });
      sessions.push({
        key:           'sprintRace',
        name:          'Sprint Race',
        scored:        !!calendar.sprintRaceScored,
        points:        slug && calendar.sprintRaceScored ? (srPointsBySlug.get(slug) ?? 0) : null,
        position:      slug && calendar.sprintRaceScored ? (srPositionBySlug.get(slug) ?? null) : null,
        scheduledDate: calendar.sprintDate ?? null,
      });
    }

    sessions.push({
      key:           'qualifying',
      name:          'Qualifying',
      scored:        !!calendar.processed,
      points:        null, // tracked in bulk via process-race-logic — future phase
      position:      null,
      scheduledDate: calendar.qualifyingDate ?? null,
    });
    sessions.push({
      key:           'race',
      name:          'Race',
      scored:        !!calendar.processed,
      points:        null, // tracked in bulk via process-race-logic — future phase
      position:      null,
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

  function buildNonDriverScore(asset: any, slotLabel: string) {
    if (!asset) return null;
    return {
      slug:            asset.slug,
      name:            asset.name,
      team:            asset.team,
      weekendPoints:   0,
      hasWeekendData:  false,
      note:            `${slotLabel} scores are added at end of race weekend`,
    };
  }

  // Which sessions have been completed so far
  const sessionsCompleted: string[] = [];
  const sessionsRemaining: string[] = [];
  const allSessions = calendar.isSprint
    ? ['sprintQuali', 'sprintRace', 'qualifying', 'race']
    : ['qualifying', 'race'];

  const scoredMap: Record<string, boolean> = {
    sprintQuali: !!calendar.sprintQualiScored,
    sprintRace:  !!calendar.sprintRaceScored,
    qualifying:  !!calendar.processed,
    race:        !!calendar.processed,
  };

  for (const key of allSessions) {
    (scoredMap[key] ? sessionsCompleted : sessionsRemaining).push(key);
  }

  const rosterScores = {
    driver1:   buildDriverScore(roster.driver1AssetId),
    driver2:   buildDriverScore(roster.driver2AssetId),
    principal: buildNonDriverScore(roster.principalAssetId, 'Principal'),
    pitCrew1:  buildNonDriverScore(roster.pitCrew1AssetId,  'Pit crew'),
    pitCrew2:  buildNonDriverScore(roster.pitCrew2AssetId,  'Pit crew'),
    powerUnit: buildNonDriverScore(roster.powerUnitAssetId, 'Power unit'),
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
