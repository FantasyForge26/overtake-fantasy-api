import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { RaceCalendar } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';

const COUNTRY_FLAGS: Record<string, string> = {
  'Australia':    '🇦🇺',
  'China':        '🇨🇳',
  'Japan':        '🇯🇵',
  'Bahrain':      '🇧🇭',
  'Saudi Arabia': '🇸🇦',
  'USA':          '🇺🇸',
  'Canada':       '🇨🇦',
  'Monaco':       '🇲🇨',
  'Spain':        '🇪🇸',
  'Austria':      '🇦🇹',
  'UK':           '🇬🇧',
  'Belgium':      '🇧🇪',
  'Hungary':      '🇭🇺',
  'Netherlands':  '🇳🇱',
  'Italy':        '🇮🇹',
  'Azerbaijan':   '🇦🇿',
  'Singapore':    '🇸🇬',
  'Mexico':       '🇲🇽',
  'Brazil':       '🇧🇷',
  'Qatar':        '🇶🇦',
  'Abu Dhabi':    '🇦🇪',
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const races = await RaceCalendar.find({ season: 2026 }).sort({ round: 1 }).lean();

  const now = new Date();

  const result = races.map((race: any) => {
    const countryFlag = COUNTRY_FLAGS[race.country] ?? '🏁';

    let status: 'cancelled' | 'completed' | 'upcoming';
    if (race.cancelled) {
      status = 'cancelled';
    } else if (new Date(race.raceDate) < now) {
      status = 'completed';
    } else {
      status = 'upcoming';
    }

    return { ...race, countryFlag, status };
  });

  return NextResponse.json(result);
}
