import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { ProcessedRace } from '@/lib/models';
import { processRace } from '@/lib/scoring/process-race-logic';

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

  // Idempotency check
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

  // Reserve the slot before fetching OpenF1
  const lock = await ProcessedRace.create({ meetingKey, raceName: null });

  let result;
  try {
    result = await processRace(meetingKey);
  } catch (err: any) {
    await ProcessedRace.deleteOne({ _id: lock._id });
    return NextResponse.json({ error: 'Scoring failed. Check server logs.' }, { status: 502 });
  }

  return NextResponse.json({
    success:       true,
    raceName:      result.raceName,
    hasSprint:     result.hasSprint,
    assetsUpdated: result.assetsUpdated,
    rostersUpdated: result.rostersUpdated,
    leagues:       result.leagues,
  });
}
