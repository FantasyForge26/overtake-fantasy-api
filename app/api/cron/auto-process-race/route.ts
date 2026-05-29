import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { RaceCalendar, ProcessedRace, Roster } from '@/lib/models';
import { processRace, ProcessRaceResult } from '@/lib/scoring/process-race-logic';
import { recalculateAllOTFv2 } from '@/lib/otf-recalculate';
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

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const calendar = await RaceCalendar.findOne({
      cancelled:  false,
      processed:  false,
      meetingKey: { $ne: null },
    }).sort({ round: 1 }).lean() as any;

    if (!calendar) {
      return NextResponse.json({ success: true, message: 'No pending races' });
    }

    // If already scored externally, mark processed and continue to next.
    // (Outside the transaction — no scoring writes here, just a flag flip.)
    const alreadyProcessed = await ProcessedRace.findOne({ meetingKey: calendar.meetingKey }).lean();
    if (alreadyProcessed) {
      await RaceCalendar.updateOne({ _id: calendar._id }, { processed: true });
      continue;
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

    // ── Atomic scoring transaction (H7) ────────────────────────────────────
    // Wraps lock creation + processRace writes + calendar.processed flag in
    // a single Mongoose ClientSession. A mid-flight failure rolls everything
    // back so the next cron tick can safely retry from scratch — no partial
    // state, no double-scoring.
    let result: ProcessRaceResult;
    const session = await mongoose.startSession();
    try {
      result = await session.withTransaction(async () => {
        await ProcessedRace.create([{ meetingKey: calendar.meetingKey, raceName: null }], { session });
        const r = await processRace(calendar.meetingKey, { session });
        await RaceCalendar.updateOne({ _id: calendar._id }, { processed: true }, { session });
        return r;
      }) as ProcessRaceResult;
    } catch (err) {
      console.error('[cron/auto-process-race] transaction failed:', err);
      return NextResponse.json({ error: 'Scoring failed. Check server logs.' }, { status: 502 });
    } finally {
      await session.endSession();
    }

    // Post-transaction: idempotent OTFv2 full-table recompute.
    try {
      const r = await recalculateAllOTFv2(2026);
      console.log(`[cron/auto-process-race] OTFv2 recalc: ${r.updated}/${r.total} updated, ${r.movers.length} big movers (Δ≥3)`);
    } catch (err) {
      console.error('[cron/auto-process-race] OTFv2 recalc failed (non-fatal):', err);
    }

    // Send push notifications to all affected managers (also post-transaction;
    // Expo push is external and not part of the atomic guarantee).
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
}
