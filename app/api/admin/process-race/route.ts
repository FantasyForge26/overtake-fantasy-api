import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { ProcessedRace } from '@/lib/models';
import { processRace, ProcessRaceResult } from '@/lib/scoring/process-race-logic';
import { recalculateAllOTFv2 } from '@/lib/otf-recalculate';

export async function POST(req: NextRequest) {
  if (req.headers.get('x-admin-key') !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const { meetingKey } = body;
  const force = req.nextUrl.searchParams.get('force') === 'true';

  if (!meetingKey) {
    return NextResponse.json({ error: 'meetingKey is required' }, { status: 400 });
  }

  await connectDB();

  // Idempotency check (pre-transaction). The transaction body re-creates the
  // lock; if force=true we delete the existing lock here so the create succeeds.
  if (force) {
    await ProcessedRace.deleteOne({ meetingKey });
  } else {
    const existing = await ProcessedRace.findOne({ meetingKey }).lean() as any;
    if (existing) {
      return NextResponse.json(
        { error: 'Race already processed', meetingKey, raceName: existing.raceName },
        { status: 409 },
      );
    }
  }

  // ── Atomic scoring transaction (H7) ─────────────────────────────────────────
  // Wraps lock creation + processRace writes in a Mongoose ClientSession.
  // A mid-flight failure rolls back the lock AND every roster/asset/calendar
  // write together. Without this, a partial failure would leave some rosters
  // double-scorable on the next retry.
  let result: ProcessRaceResult;
  const session = await mongoose.startSession();
  try {
    result = await session.withTransaction(async () => {
      await ProcessedRace.create([{ meetingKey, raceName: null }], { session });
      return processRace(meetingKey, { session });
    }) as ProcessRaceResult;
  } catch (err) {
    console.error('[admin/process-race] transaction failed:', err);
    return NextResponse.json({ error: 'Scoring failed. Check server logs.' }, { status: 502 });
  } finally {
    await session.endSession();
  }

  // Post-transaction: idempotent OTFv2 full-table recompute. Safe to re-run
  // via this endpoint if it fails; deliberately outside the transaction so
  // the lock window stays small.
  try {
    const r = await recalculateAllOTFv2(2026);
    console.log(`[admin/process-race] OTFv2 recalc: ${r.updated}/${r.total} updated, ${r.movers.length} big movers (Δ≥3)`);
  } catch (err) {
    console.error('[admin/process-race] OTFv2 recalc failed (non-fatal):', err);
  }

  return NextResponse.json({
    success:        true,
    raceName:       result.raceName,
    hasSprint:      result.hasSprint,
    assetsUpdated:  result.assetsUpdated,
    rostersUpdated: result.rostersUpdated,
    leagues:        result.leagues,
  });
}
