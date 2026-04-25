import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { RaceCalendar } from '@/lib/models';
import { findMeetingKeyForDate } from '@/lib/race-calendar-helpers';

export async function POST(req: NextRequest) {
  if (req.headers.get('x-admin-key') !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const season = new Date().getFullYear();

  const docs = await RaceCalendar.find({
    season,
    cancelled:  false,
    meetingKey: null,
  }).lean() as any[];

  const scanned = docs.length;
  const updated: { round: number; name: string; meetingKey: number }[] = [];

  for (const doc of docs) {
    const key = await findMeetingKeyForDate(new Date(doc.raceDate), doc.country);
    if (key == null) continue;

    await RaceCalendar.updateOne({ _id: doc._id }, { meetingKey: key });
    updated.push({ round: doc.round, name: doc.name, meetingKey: key });
  }

  return NextResponse.json({ success: true, season, scanned, updated });
}
