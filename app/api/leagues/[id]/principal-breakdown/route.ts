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

  // Resolve the principal → team
  const principal = await Asset.findOne({ slug, assetType: 'principal', season: 2026 }).lean() as any;
  if (!principal) return NextResponse.json({ error: 'Principal not found' }, { status: 404 });

  const teamSlug: string = principal.teamSlug;

  // Find both drivers for this team
  const teamDrivers = await Asset.find({ teamSlug, assetType: 'driver', season: 2026 }).lean() as any[];
  const driver1 = teamDrivers[0] ?? null;
  const driver2 = teamDrivers[1] ?? null;

  // Build slug → last name map
  const nameMap: Record<string, string> = {};
  for (const d of teamDrivers) {
    nameMap[d.slug] = d.lastName ?? d.name?.split(' ').pop() ?? d.slug;
  }

  const calendars = await RaceCalendar.find({ season: 2026 }).sort({ round: 1 }).lean() as any[];

  const rows: any[] = [];

  for (const cal of calendars) {
    const principalArr: any[] = cal.principalResults ?? [];
    const raceArr:      any[] = cal.raceResults      ?? [];

    // Principal's pre-computed points for this round (sum across all sessions)
    const myEntries = principalArr.filter((e: any) => e.principalSlug === slug);
    if (!myEntries.length) continue;

    const flag      = COUNTRY_FLAGS[cal.country as string] ?? '🏁';
    const shortName = (cal.country as string) ?? `R${cal.round}`;

    // Driver finish positions from RaceCalendar.raceResults
    const d1Entry = driver1 ? raceArr.find((e: any) => e.driverSlug === driver1.slug) : null;
    const d2Entry = driver2 ? raceArr.find((e: any) => e.driverSlug === driver2.slug) : null;

    const d1Pos = d1Entry && !d1Entry.notClassified && !d1Entry.dsq ? (d1Entry.position ?? null) : null;
    const d2Pos = d2Entry && !d2Entry.notClassified && !d2Entry.dsq ? (d2Entry.position ?? null) : null;

    const rPts = Math.round(myEntries.reduce((s: number, e: any) => s + (e.points ?? 0), 0) * 100) / 100;

    rows.push({
      round:       cal.round,
      flag,
      shortName,
      driver1Pos:  d1Pos,
      driver2Pos:  d2Pos,
      driver1Name: driver1 ? (nameMap[driver1.slug] ?? null) : null,
      driver2Name: driver2 ? (nameMap[driver2.slug] ?? null) : null,
      rPts,
      tot:         rPts,
    });
  }

  const totals = rows.reduce(
    (acc, r) => ({ rPts: acc.rPts + r.rPts, total: acc.total + r.tot }),
    { rPts: 0, total: 0 },
  );

  return NextResponse.json({ rows, totals });
}
