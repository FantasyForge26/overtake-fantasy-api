import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Asset, RaceCalendar } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { verifyLeagueMembership } from '@/lib/auth-helpers';

const COUNTRY_FLAGS: Record<string, string> = {
  'Australia': '🇦🇺', 'China': '🇨🇳', 'Japan': '🇯🇵',
  'Bahrain': '🇧🇭', 'Saudi Arabia': '🇸🇦', 'USA': '🇺🇸',
  'Canada': '🇨🇦', 'Monaco': '🇲🇨', 'Spain': '🇪🇸',
  'Austria': '🇦🇹', 'UK': '🇬🇧', 'Belgium': '🇧🇪',
  'Hungary': '🇭🇺', 'Netherlands': '🇳🇱', 'Italy': '🇮🇹',
  'Azerbaijan': '🇦🇿', 'Singapore': '🇸🇬', 'Mexico': '🇲🇽',
  'Brazil': '🇧🇷', 'Qatar': '🇶🇦', 'Abu Dhabi': '🇦🇪',
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId } = await params;
  const userId = (session.user as any).id as string;
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 });

  await connectDB();

  if (!(await verifyLeagueMembership(leagueId, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const pitCrew = await Asset.findOne({ slug, assetType: 'pitCrew', season: 2026 }).lean() as any;
  if (!pitCrew) return NextResponse.json({ error: 'Pit crew not found' }, { status: 404 });

  const calendars = await RaceCalendar.find({ season: 2026 }).sort({ round: 1 }).lean() as any[];

  const rows: any[] = [];

  for (const cal of calendars) {
    const pitCrewArr: any[] = cal.pitCrewResults ?? [];

    // Pit crew's pre-computed points for this round
    const myEntry = pitCrewArr.find((e: any) => e.pitCrewSlug === slug);
    if (!myEntry) continue;

    const flag      = COUNTRY_FLAGS[cal.country as string] ?? '🏁';
    const shortName = (cal.country as string) ?? `R${cal.round}`;
    const rPts      = myEntry.points as number;

    // Stop-time details are not stored in RaceCalendar arrays — UI renders null as '—'
    rows.push({
      round:            cal.round,
      flag,
      shortName,
      stopCount:        null,
      avgStopTime:      null,
      fastestStop:      null,
      wasOverallFastest: null,
      rPts,
      tot:              rPts,
    });
  }

  const totals = rows.reduce(
    (acc, r) => ({ rPts: acc.rPts + r.rPts, total: acc.total + r.tot }),
    { rPts: 0, total: 0 },
  );

  return NextResponse.json({ rows, totals });
}
