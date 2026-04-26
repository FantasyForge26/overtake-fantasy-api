import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { RaceCalendar, PerformanceSelection, Roster } from '@/lib/models';

export async function GET(req: NextRequest) {
  const authHeader  = req.headers.get('authorization');
  const querySecret = req.nextUrl.searchParams.get('secret');
  const secret      = process.env.CRON_SECRET;
  if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const now     = new Date();
  const nowPlus = new Date(now.getTime() + 5 * 60 * 1000); // now + 5 min

  // Find a race whose lock window is active: lockTime (raceDate - 5min) <= now < raceDate
  // Equivalently: now <= raceDate < now + 5min
  const race = await RaceCalendar.findOne({
    cancelled:          false,
    boostLockProcessed: { $ne: true },
    raceDate:           { $gt: now, $lte: nowPlus },
  }).sort({ round: 1 }).lean() as any;

  if (!race) {
    return NextResponse.json({ skipped: true, reason: 'No race in lock window' });
  }

  // Find all rosters for this season
  const rosters = await Roster.find({ season: 2026 }).lean() as any[];

  let usersAutoFilled = 0;
  const leaguesSeen = new Set<string>();

  for (const roster of rosters) {
    const leagueId = roster.leagueId?.toString();
    const userId   = roster.userId?.toString();
    if (!leagueId || !userId) continue;

    leaguesSeen.add(leagueId);

    // Check existing selection for this race
    const existing = await PerformanceSelection.findOne({
      leagueId, userId, season: 2026, round: race.round,
    }).lean() as any;

    const hasDriverBoost  = !!(existing?.driver1Boost || existing?.driver2Boost);
    const hasPitBoost     = !!(existing?.pitCrew1Boost || existing?.pitCrew2Boost);

    if (hasDriverBoost && hasPitBoost) continue; // User already made complete selection

    // Auto-fill missing slots with roster slot 1 defaults
    const update: Record<string, any> = {
      submittedAt: now,
      autoFilled:  true,
      locked:      true,
    };

    if (!hasDriverBoost && roster.driver1AssetId) {
      update.driver1Boost = roster.driver1AssetId;
    }
    if (!hasPitBoost && roster.pitCrew1AssetId) {
      update.pitCrew1Boost = roster.pitCrew1AssetId;
    }

    // Preserve existing valid boosts
    if (hasDriverBoost) {
      if (existing?.driver1Boost) update.driver1Boost = existing.driver1Boost;
      if (existing?.driver2Boost) update.driver2Boost = existing.driver2Boost;
    }
    if (hasPitBoost) {
      if (existing?.pitCrew1Boost) update.pitCrew1Boost = existing.pitCrew1Boost;
      if (existing?.pitCrew2Boost) update.pitCrew2Boost = existing.pitCrew2Boost;
    }

    await PerformanceSelection.findOneAndUpdate(
      { leagueId, userId, season: 2026, round: race.round },
      { $set: update },
      { upsert: true },
    );

    usersAutoFilled++;
  }

  // Mark race as boost-lock processed so cron doesn't re-run for this race
  await RaceCalendar.updateOne({ _id: race._id }, { boostLockProcessed: true });

  return NextResponse.json({
    success:          true,
    raceRound:        race.round,
    raceName:         race.name,
    leaguesProcessed: leaguesSeen.size,
    usersAutoFilled,
  });
}
