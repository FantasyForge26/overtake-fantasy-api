import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { RaceCalendar, ProcessedRace, Roster, League } from '@/lib/models';
import { processRace } from '@/lib/scoring/process-race-logic';
import { sendPushToUser } from '@/lib/push';

const RACE_BUFFER_MS = 3.5 * 60 * 60 * 1000; // 3.5 hours after raceDate

export async function GET(req: NextRequest) {
  const authHeader  = req.headers.get('authorization');
  const querySecret = req.nextUrl.searchParams.get('secret');
  const secret      = process.env.CRON_SECRET;
  if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  // Find the next unprocessed race that has a meetingKey
  const calendar = await RaceCalendar.findOne({
    cancelled:  false,
    processed:  false,
    meetingKey: { $ne: null },
  }).sort({ round: 1 }).lean() as any;

  if (!calendar) {
    return NextResponse.json({ success: true, message: 'No pending races' });
  }

  const raceDate    = new Date(calendar.raceDate);
  const raceEndTime = new Date(raceDate.getTime() + RACE_BUFFER_MS);
  const now         = new Date();

  if (now < raceEndTime) {
    const etaMinutes = Math.ceil((raceEndTime.getTime() - now.getTime()) / 60000);
    return NextResponse.json({
      success:     true,
      message:     'Race not finished yet',
      raceName:    calendar.name,
      raceDate:    raceDate.toISOString(),
      raceEndTime: raceEndTime.toISOString(),
      etaMinutes,
    });
  }

  // Idempotency check — skip if already in ProcessedRace
  const alreadyProcessed = await ProcessedRace.findOne({ meetingKey: calendar.meetingKey }).lean();
  if (alreadyProcessed) {
    // Race scored externally (e.g. via admin endpoint) — just mark calendar processed
    await RaceCalendar.updateOne({ _id: calendar._id }, { processed: true });
    return NextResponse.json({
      success:  true,
      message:  'Already processed via admin endpoint — calendar marked processed',
      raceName: (alreadyProcessed as any).raceName ?? calendar.name,
      meetingKey: calendar.meetingKey,
    });
  }

  // Reserve idempotency lock
  await ProcessedRace.create({ meetingKey: calendar.meetingKey, raceName: null });

  // Score the race
  let result;
  try {
    result = await processRace(calendar.meetingKey);
  } catch (err: any) {
    // Release lock so it can be retried
    await ProcessedRace.deleteOne({ meetingKey: calendar.meetingKey });
    return NextResponse.json({ error: `Scoring failed: ${err.message}` }, { status: 502 });
  }

  // Mark calendar as processed
  await RaceCalendar.updateOne({ _id: calendar._id }, { processed: true });

  // Send push notifications to all affected managers
  const scoredLeagueIds = result.leagues.map(l => l.leagueId);
  const notifiedUserIds = new Set<string>();
  let notificationsSent = 0;

  for (const leagueId of scoredLeagueIds) {
    const rosters = await Roster.find({ leagueId, season: 2026 }).lean() as any[];
    for (const roster of rosters) {
      const uid = roster.userId?.toString();
      if (!uid || notifiedUserIds.has(uid)) continue;
      notifiedUserIds.add(uid);

      await sendPushToUser(
        uid,
        `${result.raceName} Scored!`,
        'Check your team — points just dropped.',
        { screen: 'league', leagueId },
        'general',
      );
      notificationsSent++;
    }
  }

  return NextResponse.json({
    success:           true,
    raceName:          result.raceName,
    meetingKey:        result.meetingKey,
    hasSprint:         result.hasSprint,
    assetsUpdated:     result.assetsUpdated,
    rostersUpdated:    result.rostersUpdated,
    notificationsSent,
  });
}
