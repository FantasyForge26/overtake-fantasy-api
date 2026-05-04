/**
 * GET /api/cron/score-main-quali
 *
 * Scores main qualifying mid-weekend — called by cron after qualifying ends.
 * Awards qualifying points to each manager's two drivers, increments Roster.totalPoints.
 * Works for both sprint weekends and standard weekends.
 *
 * Safety guardrails:
 *  LIVE_SCORING_DISABLED=true  → immediate no-op (kill switch)
 *  LIVE_SCORING_TEST=true      → dry-run, no DB writes (except ScoringLog with dryRun:true)
 *  RaceCalendar.qualifyingScored → idempotency flag; returns early if already set
 *
 * Scoring uses calculateQualifyingDriverScore from lib/scoring/qualifying.ts —
 * the same formula used by process-race-logic.ts. This ensures that when
 * auto-process-race fires after the race, the qualifyingScored guard correctly
 * skips qualifying and avoids double-scoring.
 *
 * Q-stage is derived from final position:
 *   P1–10  → Q3 (reachedQ2=true, reachedQ3=true)
 *   P11–15 → Q2 (reachedQ2=true, reachedQ3=false)
 *   P16+   → Q1 (reachedQ2=false, reachedQ3=false)
 */

import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Asset, League, Roster, RaceCalendar, ScoringLog } from '@/lib/models';
import { calculateQualifyingDriverScore, type QualifyingDriverResult } from '@/lib/scoring/qualifying';
import { loadBoostedSlots, isBoosted } from '@/lib/scoring/boost-helper';

const OPENF1_BASE     = 'https://api.openf1.org/v1';
const MIN_BUFFER_MS   = 30 * 60 * 1000;       // 30 min after session end before scoring
const MAX_LOOKBACK_MS = 48 * 60 * 60 * 1000;  // only score sessions within the last 48 hours

async function openf1Get<T>(path: string): Promise<T[]> {
  const res = await fetch(`${OPENF1_BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`OpenF1 ${path} → HTTP ${res.status}`);
  return res.json() as Promise<T[]>;
}

function qStageFromPosition(pos: number): 'Q1' | 'Q2' | 'Q3' {
  if (pos <= 10) return 'Q3';
  if (pos <= 15) return 'Q2';
  return 'Q1';
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

  // ── 4. Find eligible race ──────────────────────────────────────────────────
  // Works for both sprint weekends and standard weekends.
  // Uses qualifyingDate (main qualifying), NOT sprintQualifyingDate.
  const calendar = await RaceCalendar.findOne({
    season:         2026,
    cancelled:      false,
    cancelled2026:  { $ne: true },
    qualifyingDate: { $lte: windowEnd, $gte: windowStart },
    $or: [{ qualifyingScored: { $ne: true } }, { qualifyingScored: { $exists: false } }],
  }).lean() as any;

  if (!calendar) {
    return NextResponse.json({
      skipped: true,
      reason:  'No eligible qualifying session found (already scored or outside 48h window)',
    });
  }

  // ── 5. Idempotency double-check ────────────────────────────────────────────
  if (calendar.qualifyingScored === true) {
    return NextResponse.json({
      skipped: true,
      reason:  'Qualifying already scored',
      round:   calendar.round,
    });
  }

  // ── 6. Fetch OpenF1 qualifying session ─────────────────────────────────────
  let sessions: any[];
  try {
    sessions = await openf1Get<any>(
      `/sessions?meeting_key=${calendar.meetingKey}&session_name=Qualifying`,
    );
  } catch (err: any) {
    await ScoringLog.create({
      event: 'error', season: 2026, round: calendar.round,
      processedAt: new Date(), errorMessage: `OpenF1 session fetch failed: ${err.message}`, dryRun,
    });
    return NextResponse.json({ error: 'OpenF1 session fetch failed', detail: err.message }, { status: 502 });
  }

  if (!sessions.length) {
    return NextResponse.json({ error: 'Qualifying session not found on OpenF1' }, { status: 502 });
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
    return NextResponse.json(
      { error: 'No position data from OpenF1 yet — try again in a few minutes' },
      { status: 502 },
    );
  }

  // Group by driver_number, sort desc by date, take first = latest (final classification)
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

  // ── 8. Load driver assets, build carNumber → team/slug maps ───────────────
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

  // ── 9. Build QualifyingDriverResult[] (same shape as lib/scoring/qualifying.ts) ─
  // This ensures the scoring formula matches exactly what process-race-logic would use.
  const qualResults: QualifyingDriverResult[] = [];
  for (const [driverNum, pos] of finalPosByDriverNum) {
    const team = teamByCarNum.get(driverNum);
    if (!team) continue; // not a known 2026 driver, skip
    qualResults.push({
      driverNumber:  driverNum,
      teamName:      team,
      finalPosition: pos,
      reachedQ2:     pos <= 15,
      reachedQ3:     pos <= 10,
      setLapTime:    true,  // appeared in position data → set a lap time
      status:        'Qualified',
    });
  }

  // ── 10. Calculate qualifying scores ───────────────────────────────────────
  // calculateQualifyingDriverScore handles teammate comparison internally.
  const qualScores = qualResults.map(r => ({
    result: r,
    score:  calculateQualifyingDriverScore(r, qualResults),
  }));

  const qualifyingResults: {
    driverSlug: string;
    position: number;
    stage: string;
    points: number;
    fastestLap: boolean;
  }[] = [];
  const pointsBySlug = new Map<string, number>();

  for (const { result, score } of qualScores) {
    const slug = slugByCarNum.get(result.driverNumber);
    if (!slug) continue;
    const stage = qStageFromPosition(result.finalPosition ?? 20);
    qualifyingResults.push({
      driverSlug: slug,
      position:   result.finalPosition ?? 20,
      stage,
      points:     score.total,
      fastestLap: false,
    });
    pointsBySlug.set(slug, score.total);
  }

  qualifyingResults.sort((a, b) => a.position - b.position);

  // ── 11. Score all active league rosters ───────────────────────────────────
  const leagues = await League.find({ status: 'active' }).lean() as any[];
  const teamUpdateLog: { rosterId: string; leagueId: string; pointsAdded: number; boostedSlugs: string[] }[] = [];
  let teamsUpdated = 0;

  for (const league of leagues) {
    const leagueId = league._id.toString();
    const rosters  = await Roster.find({ leagueId, season: 2026 });
    if (!rosters.length) continue;

    // Load locked boost selections for this league + round
    const boosts = await loadBoostedSlots(leagueId, calendar.round, 2026);

    for (const roster of rosters) {
      const rosterId = roster._id.toString();
      const d1 = roster.driver1AssetId ? assetByIdStr.get(roster.driver1AssetId.toString()) : null;
      const d2 = roster.driver2AssetId ? assetByIdStr.get(roster.driver2AssetId.toString()) : null;

      const d1Mult = d1 && isBoosted(boosts, rosterId, d1.slug) ? 2 : 1;
      const d2Mult = d2 && isBoosted(boosts, rosterId, d2.slug) ? 2 : 1;
      const d1Pts = d1 ? (pointsBySlug.get(d1.slug) ?? 0) * d1Mult : 0;
      const d2Pts = d2 ? (pointsBySlug.get(d2.slug) ?? 0) * d2Mult : 0;
      const totalAdded = Math.round((d1Pts + d2Pts) * 100) / 100;

      const boostedSlugs = [
        ...(d1Mult === 2 && d1 ? [d1.slug] : []),
        ...(d2Mult === 2 && d2 ? [d2.slug] : []),
      ];

      teamUpdateLog.push({ rosterId, leagueId, pointsAdded: totalAdded, boostedSlugs });
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

  // ── 12. Atomically set qualifyingScored on RaceCalendar ───────────────────
  if (!dryRun) {
    await RaceCalendar.findOneAndUpdate(
      {
        _id:  calendar._id,
        $or: [{ qualifyingScored: { $ne: true } }, { qualifyingScored: { $exists: false } }],
      },
      {
        $set: {
          qualifyingScored:   true,
          qualifyingScoredAt: new Date(),
          qualifyingResults,
        },
      },
    );
  }

  // ── 13. Write audit log ────────────────────────────────────────────────────
  await ScoringLog.create({
    event:              'qualifying_scored',
    season:             2026,
    round:              calendar.round,
    processedAt:        new Date(),
    sprintQualiResults: qualifyingResults, // mixed field — reused for audit storage
    teamUpdates:        teamUpdateLog.map(u => ({
      rosterId:    u.rosterId,
      leagueId:    u.leagueId,
      pointsAdded: u.pointsAdded,
      boostedSlugs: u.boostedSlugs,
    })),
    dryRun,
  });

  // ── 14. Response ───────────────────────────────────────────────────────────
  const totalPointsAdded = teamUpdateLog.reduce((s, u) => s + u.pointsAdded, 0);

  return NextResponse.json({
    dryRun,
    round:            calendar.round,
    raceName:         calendar.name,
    sessionKey,
    driversScored:    qualifyingResults.length,
    leaguesProcessed: leagues.length,
    teamsUpdated,
    totalPointsAdded: Math.round(totalPointsAdded * 100) / 100,
    results: qualifyingResults.map(r => ({
      pos:    r.position,
      stage:  r.stage,
      driver: r.driverSlug,
      pts:    r.points,
    })),
  });
}
