/**
 * GET /api/cron/score-sprint-race
 *
 * Scores the sprint race mid-weekend — called by cron after the sprint race ends.
 * Awards sprint race points to each manager's two drivers, increments Roster.totalPoints.
 *
 * Safety guardrails:
 *  LIVE_SCORING_DISABLED=true  → immediate no-op (kill switch)
 *  LIVE_SCORING_TEST=true      → dry-run, no DB writes (except ScoringLog with dryRun:true)
 *  RaceCalendar.sprintRaceScored → idempotency flag; returns early if already set
 *
 * Scoring uses calculateDriverSprintScore from lib/otf-calculator.ts:
 *  - finishPosition / startPosition / teammateFinishPosition
 *  - fastestLap (driver with shortest lap_duration where is_pit_out_lap=false)
 *  - notClassified: lapped > 1 lap behind leader (true DNF, not lapped finishers)
 *  - dsq: defaults false (sprint DSQs are extremely rare; handle manually if needed)
 *
 * Start positions: primary = RaceCalendar.sprintQualiResults (stored by score-sprint-quali).
 * Fallback = finish position (zero position delta) if sprint quali wasn't scored.
 */

import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Asset, League, Roster, RaceCalendar, ScoringLog } from '@/lib/models';
import { calculateDriverSprintScore } from '@/lib/otf-calculator';

const OPENF1_BASE     = 'https://api.openf1.org/v1';
const MIN_BUFFER_MS   = 30 * 60 * 1000;       // 30 min after session end before scoring
const MAX_LOOKBACK_MS = 48 * 60 * 60 * 1000;  // only score sessions within the last 48 hours

async function openf1Get<T>(path: string): Promise<T[]> {
  const res = await fetch(`${OPENF1_BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`OpenF1 ${path} → HTTP ${res.status}`);
  return res.json() as Promise<T[]>;
}

/** Returns driver_number of driver with fastest valid lap (lowest lap_duration, is_pit_out_lap=false) */
function findFastestLapDriverNum(laps: any[]): number | null {
  let fastestDuration: number | null = null;
  let fastestDriverNum: number | null = null;
  for (const lap of laps) {
    if (lap.lap_duration == null)    continue;
    if (lap.is_pit_out_lap === true) continue;
    if (fastestDuration === null || lap.lap_duration < fastestDuration) {
      fastestDuration  = lap.lap_duration;
      fastestDriverNum = lap.driver_number;
    }
  }
  return fastestDriverNum;
}

/** Returns max laps completed per driver_number */
function maxLapsByDriverNum(laps: any[]): Map<number, number> {
  const result = new Map<number, number>();
  for (const lap of laps) {
    const prev = result.get(lap.driver_number) ?? 0;
    if (lap.lap_number > prev) result.set(lap.driver_number, lap.lap_number);
  }
  return result;
}

export async function GET(req: NextRequest) {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authHeader  = req.headers.get('authorization');
  const querySecret = req.nextUrl.searchParams.get('secret');
  const secret      = process.env.CRON_SECRET;
  if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── 2. Kill switch ─────────────────────────────────────────────────────────
  if (process.env.LIVE_SCORING_DISABLED === 'true') {
    return NextResponse.json({ skipped: true, reason: 'LIVE_SCORING_DISABLED' });
  }

  // ── 3. Dry-run mode ────────────────────────────────────────────────────────
  const dryRun = process.env.LIVE_SCORING_TEST === 'true';

  await connectDB();

  const now         = new Date();
  const windowEnd   = new Date(now.getTime() - MIN_BUFFER_MS);
  const windowStart = new Date(now.getTime() - MAX_LOOKBACK_MS);

  // ── 4. Find eligible sprint race ───────────────────────────────────────────
  const calendar = await RaceCalendar.findOne({
    season:     2026,
    isSprint:   true,
    cancelled:  false,
    sprintDate: { $lte: windowEnd, $gte: windowStart },
    $or: [{ sprintRaceScored: { $ne: true } }, { sprintRaceScored: { $exists: false } }],
  }).lean() as any;

  if (!calendar) {
    return NextResponse.json({
      skipped: true,
      reason:  'No eligible sprint race found (already scored or outside 48h window)',
    });
  }

  // ── 5. Idempotency double-check ────────────────────────────────────────────
  if (calendar.sprintRaceScored === true) {
    return NextResponse.json({
      skipped: true,
      reason:  'Sprint race already scored',
      round:   calendar.round,
    });
  }

  // ── 6. Fetch OpenF1 sprint session ─────────────────────────────────────────
  let sessions: any[];
  try {
    sessions = await openf1Get<any>(
      `/sessions?meeting_key=${calendar.meetingKey}&session_name=Sprint`,
    );
  } catch (err: any) {
    await ScoringLog.create({
      event: 'error', season: 2026, round: calendar.round,
      processedAt: new Date(), errorMessage: `OpenF1 session fetch failed: ${err.message}`, dryRun,
    });
    return NextResponse.json({ error: 'OpenF1 session fetch failed', detail: err.message }, { status: 502 });
  }

  if (!sessions.length) {
    return NextResponse.json({ error: 'Sprint session not found on OpenF1' }, { status: 502 });
  }

  const sessionKey: number = sessions[0].session_key;

  // ── 7. Fetch position data and laps in parallel ────────────────────────────
  let positions: any[];
  let laps: any[];
  try {
    [positions, laps] = await Promise.all([
      openf1Get<any>(`/position?session_key=${sessionKey}`),
      openf1Get<any>(`/laps?session_key=${sessionKey}`),
    ]);
  } catch (err: any) {
    await ScoringLog.create({
      event: 'error', season: 2026, round: calendar.round,
      processedAt: new Date(), errorMessage: `OpenF1 data fetch failed: ${err.message}`, dryRun,
    });
    return NextResponse.json({ error: 'OpenF1 data fetch failed', detail: err.message }, { status: 502 });
  }

  if (!positions.length) {
    return NextResponse.json(
      { error: 'No position data from OpenF1 yet — try again in a few minutes' },
      { status: 502 },
    );
  }

  // ── 8. Derive final position per driver (latest position entry) ────────────
  const entriesByDriver = new Map<number, any[]>();
  for (const p of positions) {
    const arr = entriesByDriver.get(p.driver_number) ?? [];
    arr.push(p);
    entriesByDriver.set(p.driver_number, arr);
  }

  const finalPosByDriverNum = new Map<number, number>();
  for (const [driverNum, entries] of entriesByDriver) {
    entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    finalPosByDriverNum.set(driverNum, entries[0].position);
  }

  // ── 9. Fastest lap & DNF detection from laps data ─────────────────────────
  const fastestLapDriverNum = findFastestLapDriverNum(laps);

  const lapsByDriver = maxLapsByDriverNum(laps);
  const raceTotalLaps = lapsByDriver.size > 0 ? Math.max(...lapsByDriver.values()) : 0;

  // notClassified = driver completed more than 1 lap fewer than the race leader
  function isNotClassified(driverNum: number): boolean {
    if (raceTotalLaps === 0) return false;
    const driverLaps = lapsByDriver.get(driverNum) ?? 0;
    return driverLaps < raceTotalLaps - 1;
  }

  // ── 10. Load assets, build teammate map ───────────────────────────────────
  const driverAssets = await Asset.find({ season: 2026, assetType: 'driver', isActive: true }).lean() as any[];

  const slugByCarNum = new Map<number, string>(
    driverAssets.filter((a: any) => a.carNumber).map((a: any) => [a.carNumber as number, a.slug as string]),
  );
  const teamByCarNum = new Map<number, string>(
    driverAssets.filter((a: any) => a.carNumber).map((a: any) => [a.carNumber as number, a.team as string]),
  );
  const assetByIdStr = new Map<string, any>(
    driverAssets.map((a: any) => [a._id.toString(), a]),
  );

  // team → [carNumbers] for teammate finish position lookup
  const carNumsByTeam = new Map<string, number[]>();
  for (const [carNum, team] of teamByCarNum) {
    const arr = carNumsByTeam.get(team) ?? [];
    arr.push(carNum);
    carNumsByTeam.set(team, arr);
  }

  // ── 11. Build start position lookup ───────────────────────────────────────
  // Primary: sprintQualiResults stored from score-sprint-quali (Phase 3)
  // These ARE the sprint race starting grid.
  const startPosBySlug = new Map<string, number>();
  if (Array.isArray(calendar.sprintQualiResults)) {
    for (const sqr of calendar.sprintQualiResults) {
      if (sqr.driverSlug && sqr.position) startPosBySlug.set(sqr.driverSlug, sqr.position);
    }
  }

  // ── 12. Calculate sprint race score per driver ────────────────────────────
  const sprintRaceResults: {
    driverSlug: string;
    position: number;
    startPosition: number;
    points: number;
    fastestLap: boolean;
  }[] = [];
  const pointsBySlug = new Map<string, number>();

  for (const [driverNum, finishPos] of finalPosByDriverNum) {
    const slug = slugByCarNum.get(driverNum);
    if (!slug) continue;

    const notClassified = isNotClassified(driverNum);
    const fastestLap    = driverNum === fastestLapDriverNum;

    // Start position: stored sprint quali results first, fallback to finish position (zero delta)
    const startPos = startPosBySlug.get(slug) ?? finishPos;

    // Teammate finish position (high number if teammate not in data)
    const team      = teamByCarNum.get(driverNum) ?? '';
    const teammates = (carNumsByTeam.get(team) ?? []).filter(n => n !== driverNum);
    const teammateFinishPos = teammates.length > 0
      ? (finalPosByDriverNum.get(teammates[0]) ?? 20)
      : 20;

    const pts = calculateDriverSprintScore({
      finishPosition:         notClassified ? 20 : finishPos,
      startPosition:          startPos,
      teammateFinishPosition: teammateFinishPos,
      fastestLap,
      notClassified,
      dsq: false,
    });

    sprintRaceResults.push({ driverSlug: slug, position: finishPos, startPosition: startPos, points: pts, fastestLap });
    pointsBySlug.set(slug, pts);
  }

  sprintRaceResults.sort((a, b) => a.position - b.position);

  // ── 13. Score all active league rosters ───────────────────────────────────
  const leagues = await League.find({ status: 'active' }).lean() as any[];
  const teamUpdateLog: { rosterId: string; leagueId: string; pointsAdded: number }[] = [];
  let teamsUpdated = 0;

  for (const league of leagues) {
    const leagueId = league._id.toString();
    const rosters  = await Roster.find({ leagueId, season: 2026 });
    if (!rosters.length) continue;

    for (const roster of rosters) {
      const d1 = roster.driver1AssetId ? assetByIdStr.get(roster.driver1AssetId.toString()) : null;
      const d2 = roster.driver2AssetId ? assetByIdStr.get(roster.driver2AssetId.toString()) : null;

      const d1Pts = d1 ? (pointsBySlug.get(d1.slug) ?? 0) : 0;
      const d2Pts = d2 ? (pointsBySlug.get(d2.slug) ?? 0) : 0;
      const totalAdded = Math.round((d1Pts + d2Pts) * 100) / 100;

      teamUpdateLog.push({ rosterId: roster._id.toString(), leagueId, pointsAdded: totalAdded });
      if (totalAdded !== 0) teamsUpdated++;

      if (!dryRun) {
        await Roster.findByIdAndUpdate(roster._id, {
          $inc: { totalPoints: totalAdded },
          $set: { updatedAt: new Date() },
        });
      }
    }

    // Rerank rosters in this league
    if (!dryRun) {
      const updatedRosters = await Roster.find({ leagueId, season: 2026 });
      const ranked = [...updatedRosters].sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
      for (let i = 0; i < ranked.length; i++) {
        ranked[i].seasonRank = i + 1;
        await ranked[i].save();
      }
    }
  }

  // ── 14. Atomically set sprintRaceScored on RaceCalendar ───────────────────
  if (!dryRun) {
    await RaceCalendar.findOneAndUpdate(
      {
        _id:  calendar._id,
        $or: [{ sprintRaceScored: { $ne: true } }, { sprintRaceScored: { $exists: false } }],
      },
      {
        $set: {
          sprintRaceScored:   true,
          sprintRaceScoredAt: new Date(),
          sprintRaceResults,
        },
      },
    );
  }

  // ── 15. Write audit log ────────────────────────────────────────────────────
  await ScoringLog.create({
    event:              'sprint_race_scored',
    season:             2026,
    round:              calendar.round,
    processedAt:        new Date(),
    sprintQualiResults: sprintRaceResults, // mixed field — stores sprint race results for audit
    teamUpdates:        teamUpdateLog.map(u => ({
      rosterId:    u.rosterId,
      leagueId:    u.leagueId,
      pointsAdded: u.pointsAdded,
    })),
    dryRun,
  });

  // ── 16. Response ───────────────────────────────────────────────────────────
  const totalPointsAdded = teamUpdateLog.reduce((s, u) => s + u.pointsAdded, 0);

  return NextResponse.json({
    dryRun,
    round:            calendar.round,
    raceName:         calendar.name,
    sessionKey,
    raceTotalLaps,
    driversScored:    sprintRaceResults.length,
    leaguesProcessed: leagues.length,
    teamsUpdated,
    totalPointsAdded: Math.round(totalPointsAdded * 100) / 100,
    results: sprintRaceResults.map(r => ({
      pos:        r.position,
      startPos:   r.startPosition,
      driver:     r.driverSlug,
      pts:        r.points,
      fastestLap: r.fastestLap,
    })),
  });
}
