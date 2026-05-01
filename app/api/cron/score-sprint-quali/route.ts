/**
 * GET /api/cron/score-sprint-quali
 *
 * Scores sprint qualifying mid-weekend — called by cron after sprint quali ends.
 * Awards sprintQualiPts to each manager's two drivers, increments Roster.totalPoints.
 *
 * Safety guardrails:
 *  LIVE_SCORING_DISABLED=true  → immediate no-op (kill switch)
 *  LIVE_SCORING_TEST=true      → dry-run, no DB writes (except ScoringLog with dryRun:true)
 *  RaceCalendar.sprintQualiScored → idempotency flag; returns early if already set
 *
 * Note: RaceResult is per-league and may not exist yet when sprint quali is scored
 * (the race hasn't happened). Global idempotency flag lives on RaceCalendar instead.
 */

import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Asset, League, Roster, RaceCalendar, ScoringLog } from '@/lib/models';
import { calculateDriverSprintQualifyingScore } from '@/lib/otf-calculator';

const OPENF1_BASE = 'https://api.openf1.org/v1';
const MIN_BUFFER_MS  = 30 * 60 * 1000;       // 30 min after session end before scoring
const MAX_LOOKBACK_MS = 48 * 60 * 60 * 1000; // only score sessions within the last 48 hours

async function openf1Get<T>(path: string): Promise<T[]> {
  const res = await fetch(`${OPENF1_BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`OpenF1 ${path} → HTTP ${res.status}`);
  return res.json() as Promise<T[]>;
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

  const now        = new Date();
  const windowEnd  = new Date(now.getTime() - MIN_BUFFER_MS);   // must be at least 30 min ago
  const windowStart = new Date(now.getTime() - MAX_LOOKBACK_MS); // must be within 48 hours

  // ── 4. Find eligible sprint race ───────────────────────────────────────────
  const calendar = await RaceCalendar.findOne({
    season:              2026,
    isSprint:            true,
    cancelled:           false,
    sprintQualifyingDate: { $lte: windowEnd, $gte: windowStart },
    $or: [{ sprintQualiScored: { $ne: true } }, { sprintQualiScored: { $exists: false } }],
  }).lean() as any;

  if (!calendar) {
    return NextResponse.json({
      skipped: true,
      reason:  'No eligible sprint qualifying session found (already scored or outside 48h window)',
    });
  }

  // ── 5. Idempotency double-check ────────────────────────────────────────────
  if (calendar.sprintQualiScored === true) {
    return NextResponse.json({
      skipped: true,
      reason:  'Sprint qualifying already scored',
      round:   calendar.round,
    });
  }

  // ── 6. Fetch OpenF1 sprint qualifying session ──────────────────────────────
  let sessions: any[];
  try {
    sessions = await openf1Get<any>(
      `/sessions?meeting_key=${calendar.meetingKey}&session_name=Sprint%20Qualifying`,
    );
  } catch (err: any) {
    await ScoringLog.create({
      event: 'error', season: 2026, round: calendar.round,
      processedAt: new Date(), errorMessage: `OpenF1 session fetch failed: ${err.message}`, dryRun,
    });
    return NextResponse.json({ error: 'OpenF1 session fetch failed', detail: err.message }, { status: 502 });
  }

  if (!sessions.length) {
    return NextResponse.json({ error: 'Sprint qualifying session not found on OpenF1' }, { status: 502 });
  }

  const sessionKey: number = sessions[0].session_key;

  // ── 7. Fetch position data — take latest entry per driver ──────────────────
  let positions: any[];
  try {
    positions = await openf1Get<any>(`/position?session_key=${sessionKey}`);
  } catch (err: any) {
    await ScoringLog.create({
      event: 'error', season: 2026, round: calendar.round,
      processedAt: new Date(), errorMessage: `OpenF1 position fetch failed: ${err.message}`, dryRun,
    });
    return NextResponse.json({ error: 'OpenF1 position fetch failed', detail: err.message }, { status: 502 });
  }

  if (!positions.length) {
    return NextResponse.json({ error: 'No position data from OpenF1 yet — try again in a few minutes' }, { status: 502 });
  }

  // Group entries by driver_number, sort desc by date, take first = latest position
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

  // ── 8. Map driver_number → slug, calculate sprint quali points ─────────────
  const driverAssets = await Asset.find({ season: 2026, assetType: 'driver', isActive: true }).lean() as any[];
  const slugByCarNum = new Map<number, string>(
    driverAssets.filter((a: any) => a.carNumber).map((a: any) => [a.carNumber as number, a.slug as string]),
  );
  const assetByIdStr = new Map<string, any>(
    driverAssets.map((a: any) => [a._id.toString(), a]),
  );

  const sprintQualiResults: { driverSlug: string; position: number; points: number }[] = [];
  const pointsBySlug = new Map<string, number>();

  for (const [driverNum, pos] of finalPosByDriverNum) {
    const slug = slugByCarNum.get(driverNum);
    if (!slug) continue;
    const pts = calculateDriverSprintQualifyingScore(pos);
    sprintQualiResults.push({ driverSlug: slug, position: pos, points: pts });
    pointsBySlug.set(slug, pts);
  }
  sprintQualiResults.sort((a, b) => a.position - b.position);

  // ── 9. Score all active league rosters ────────────────────────────────────
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
      if (totalAdded > 0) teamsUpdated++;

      // TODO: boost multipliers — PerformanceSelection.driver1Boost/driver2Boost
      // Currently skipped to match existing process-race-logic.ts which also omits boost application.

      if (!dryRun) {
        await Roster.findByIdAndUpdate(roster._id, {
          $inc: { totalPoints: totalAdded },
          $set: { updatedAt: new Date() },
        });
      }
    }

    // Rerank rosters in this league after updating points
    if (!dryRun) {
      const updatedRosters = await Roster.find({ leagueId, season: 2026 });
      const ranked = [...updatedRosters].sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
      for (let i = 0; i < ranked.length; i++) {
        ranked[i].seasonRank = i + 1;
        await ranked[i].save();
      }
    }
  }

  // ── 10. Atomically set sprintQualiScored on RaceCalendar ──────────────────
  if (!dryRun) {
    await RaceCalendar.findOneAndUpdate(
      {
        _id:              calendar._id,
        // Extra safety: only update if still not scored (atomic guard)
        $or: [{ sprintQualiScored: { $ne: true } }, { sprintQualiScored: { $exists: false } }],
      },
      {
        $set: {
          sprintQualiScored:   true,
          sprintQualiScoredAt: new Date(),
          sprintQualiResults,
        },
      },
    );
  }

  // ── 11. Write audit log ────────────────────────────────────────────────────
  await ScoringLog.create({
    event:              'sprint_quali_scored',
    season:             2026,
    round:              calendar.round,
    processedAt:        new Date(),
    sprintQualiResults,
    teamUpdates:        teamUpdateLog.map(u => ({
      rosterId:    u.rosterId,
      leagueId:    u.leagueId,
      pointsAdded: u.pointsAdded,
    })),
    dryRun,
  });

  // ── 12. Response ───────────────────────────────────────────────────────────
  const totalPointsAdded = teamUpdateLog.reduce((s, u) => s + u.pointsAdded, 0);

  return NextResponse.json({
    dryRun,
    round:            calendar.round,
    raceName:         calendar.name,
    sessionKey,
    driversScored:    sprintQualiResults.length,
    leaguesProcessed: leagues.length,
    teamsUpdated,
    totalPointsAdded: Math.round(totalPointsAdded * 100) / 100,
    // Preview table (always shown, whether dry-run or live)
    results: sprintQualiResults.map(r => ({
      pos:    r.position,
      driver: r.driverSlug,
      pts:    r.points,
    })),
  });
}
