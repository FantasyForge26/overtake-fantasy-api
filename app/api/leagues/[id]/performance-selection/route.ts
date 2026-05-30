import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Roster, PerformanceSelection, RaceCalendar } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { firstSessionLockTime } from '@/lib/race-calendar-helpers';
import { verifyLeagueMembership } from '@/lib/auth-helpers';
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  const { id: leagueId } = await params;

  await connectDB();

  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const now = new Date();

  const upcomingRace = await RaceCalendar.findOne({
    season: 2026,
    cancelled: false,
    raceDate: { $gt: now },
  }).sort({ round: 1 });

  if (!upcomingRace) {
    return NextResponse.json({ error: 'No upcoming race found' }, { status: 404 });
  }

  const raceLockTime = firstSessionLockTime(upcomingRace);
  const isLocked = now >= raceLockTime;

  const [roster, existingSelection, seasonSelections] = await Promise.all([
    Roster.findOne({ leagueId, userId }),
    PerformanceSelection.findOne({ leagueId, userId, season: 2026, round: upcomingRace.round }),
    PerformanceSelection.find({ leagueId, userId, season: 2026 }).lean(),
  ]);

  const driver1BoostCount  = seasonSelections.filter((s: any) => s.driver1Boost).length;
  const driver2BoostCount  = seasonSelections.filter((s: any) => s.driver2Boost).length;
  const pitCrew1BoostCount = seasonSelections.filter((s: any) => s.pitCrew1Boost).length;
  const pitCrew2BoostCount = seasonSelections.filter((s: any) => s.pitCrew2Boost).length;

  const remainingRaces = await RaceCalendar.countDocuments({
    season: 2026,
    cancelled: false,
    raceDate: { $gt: now },
  });

  const maxBoostsSlot1 = Math.ceil(remainingRaces / 2);
  const maxBoostsSlot2 = Math.floor(remainingRaces / 2);

  return NextResponse.json({
    upcomingRace,
    selection: existingSelection,
    roster,
    isLocked,
    lockTime: raceLockTime.toISOString(),
    autoFilled: (existingSelection as any)?.autoFilled ?? false,
    boostCounts: {
      driver1: driver1BoostCount,
      driver2: driver2BoostCount,
      pitCrew1: pitCrew1BoostCount,
      pitCrew2: pitCrew2BoostCount,
    },
    maxBoosts: {
      driver1: maxBoostsSlot1,
      driver2: maxBoostsSlot2,
      pitCrew1: maxBoostsSlot1,
      pitCrew2: maxBoostsSlot2,
    },
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  const { id: leagueId } = await params;

  // 'write' preset (60/min per user). Plenty for normal boost-selection
  // flow, hard cap against a script flipping selections to game scoring.
  const rl = await checkRateLimit('write', `perf-selection:${userId}`);
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterSec);

  const { round, driver1Boost, driver2Boost, pitCrew1Boost, pitCrew2Boost } = await req.json();

  await connectDB();

  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const race = await RaceCalendar.findOne({ season: 2026, round, cancelled: false });
  if (!race) {
    return NextResponse.json({ error: 'Race not found' }, { status: 404 });
  }

  // Lock check: 5 minutes before earliest scoring session
  if (new Date() >= firstSessionLockTime(race)) {
    return NextResponse.json(
      { error: 'Boost selection deadline has passed. Selections are now locked.' },
      { status: 403 },
    );
  }

  const roster = await Roster.findOne({ leagueId, userId });
  if (!roster) {
    return NextResponse.json({ error: 'Roster not found' }, { status: 404 });
  }

  // Validate boosts match roster slots
  if (driver1Boost && roster.driver1AssetId?.toString() !== driver1Boost) {
    return NextResponse.json({ error: 'driver1Boost must match your driver1 roster slot' }, { status: 400 });
  }
  if (driver2Boost && roster.driver2AssetId?.toString() !== driver2Boost) {
    return NextResponse.json({ error: 'driver2Boost must match your driver2 roster slot' }, { status: 400 });
  }
  if (pitCrew1Boost && roster.pitCrew1AssetId?.toString() !== pitCrew1Boost) {
    return NextResponse.json({ error: 'pitCrew1Boost must match your pitCrew1 roster slot' }, { status: 400 });
  }
  if (pitCrew2Boost && roster.pitCrew2AssetId?.toString() !== pitCrew2Boost) {
    return NextResponse.json({ error: 'pitCrew2Boost must match your pitCrew2 roster slot' }, { status: 400 });
  }

  const selection = await PerformanceSelection.findOneAndUpdate(
    { leagueId, userId, season: 2026, round },
    {
      $set: {
        driver1Boost:  driver1Boost  ?? null,
        driver2Boost:  driver2Boost  ?? null,
        pitCrew1Boost: pitCrew1Boost ?? null,
        pitCrew2Boost: pitCrew2Boost ?? null,
        submittedAt: new Date(),
        locked: false,
        autoFilled: false,
      },
    },
    { upsert: true, new: true },
  );

  return NextResponse.json(selection);
}
