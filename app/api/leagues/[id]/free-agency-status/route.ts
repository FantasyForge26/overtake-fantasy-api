/**
 * GET /api/leagues/[id]/free-agency-status
 *
 * Returns whether free-agent Add/Bid actions are currently locked because a
 * race weekend is in progress.
 *
 * Locked window: from the first session lock time (5 min before the earliest
 * scoring session — same time boosts lock) until the race is over (~3h after
 * the Grand Prix start). Outside that window, free agency is open.
 *
 * Response: { locked: boolean, reason: string, raceName?, lockUntil?, opensAt? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { RaceCalendar } from '@/lib/models';
import { verifyLeagueMembership } from '@/lib/auth-helpers';
import { firstSessionLockTime } from '@/lib/race-calendar-helpers';

// Estimated time from the race session start to "race over" (race + cooldown).
const RACE_DURATION_MS = 3 * 60 * 60 * 1000;
// How far back we still consider a race the "current" weekend.
const LOOKBACK_MS = 36 * 60 * 60 * 1000;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId } = await params;
  const userId = (session.user as any).id as string;

  await connectDB();
  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const now = new Date();

  // Nearest race that's either upcoming or finished within the last ~36h.
  const cal = await RaceCalendar.findOne({
    season:    2026,
    cancelled: false,
    raceDate:  { $gte: new Date(now.getTime() - LOOKBACK_MS) },
  })
    .sort({ raceDate: 1 })
    .lean() as any;

  if (!cal) {
    return NextResponse.json({ locked: false, reason: 'No upcoming races' });
  }

  const firstLock = firstSessionLockTime(cal);
  const raceOver  = new Date(new Date(cal.raceDate).getTime() + RACE_DURATION_MS);

  const locked = now >= firstLock && now < raceOver;

  if (locked) {
    return NextResponse.json({
      locked:    true,
      reason:    `${cal.name ?? 'Race weekend'} is in progress — free agency reopens after the race.`,
      raceName:  cal.name,
      round:     cal.round,
      opensAt:   raceOver,
    });
  }

  return NextResponse.json({
    locked:    false,
    reason:    'Free agency is open',
    raceName:  cal.name,
    round:     cal.round,
    lockAt:    firstLock,
  });
}
