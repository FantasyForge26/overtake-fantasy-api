import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Asset, RaceResult, RaceCalendar } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { FINISH_POINTS } from '@/lib/otf-calculator';

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
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 });

  await connectDB();

  // Resolve the principal → team
  const principal = await Asset.findOne({ slug, assetType: 'principal' }).lean() as any;
  if (!principal) return NextResponse.json({ error: 'Principal not found' }, { status: 404 });

  const teamSlug: string = principal.teamSlug;
  console.log(`[principal-breakdown] leagueId="${leagueId}" slug="${slug}" teamSlug="${teamSlug}"`);

  // Find both drivers for this team
  const teamDrivers = await Asset.find({ teamSlug, assetType: 'driver' }).lean() as any[];
  const driver1 = teamDrivers[0] ?? null;
  const driver2 = teamDrivers[1] ?? null;
  console.log(`[principal-breakdown] drivers found: ${teamDrivers.length} — d1="${driver1?.slug ?? 'none'}" d2="${driver2?.slug ?? 'none'}"`);

  // Build slug → last name map
  const nameMap: Record<string, string> = {};
  for (const d of teamDrivers) {
    nameMap[d.slug] = d.lastName ?? d.name?.split(' ').pop() ?? d.slug;
  }

  // Race calendar for flags / country names
  const calendar = await RaceCalendar.find({ season: 2026 }).lean() as any[];
  const calByRound: Record<number, any> = {};
  for (const c of calendar) calByRound[c.round] = c;

  // All scored race rounds for this league
  const raceResults = await RaceResult.find({ leagueId, season: 2026, raceScored: true })
    .sort({ round: 1 })
    .lean() as any[];
  console.log('[principal-breakdown] raceResults found:', raceResults.length);
  if (raceResults.length > 0) {
    console.log('[principal-breakdown] first raceResult driverResults:', JSON.stringify((raceResults[0].driverResults ?? []).map((d: any) => d.driverSlug)));
  }

  const rows: any[] = [];

  for (const rr of raceResults) {
    const driverResults: any[] = rr.driverResults ?? [];

    // Find results for each team driver
    const d1Result = driver1 ? driverResults.find((d: any) => d.driverSlug === driver1.slug) : null;
    const d2Result = driver2 ? driverResults.find((d: any) => d.driverSlug === driver2.slug) : null;

    // Skip if neither driver has a result this round
    if (!d1Result && !d2Result) continue;

    const cal = calByRound[rr.round];
    const flag = cal ? (COUNTRY_FLAGS[cal.country] ?? '🏁') : '🏁';
    const shortName = cal?.country ?? `R${rr.round}`;

    const d1Pos   = d1Result && !d1Result.dnf && !d1Result.notClassified ? (d1Result.finishPosition ?? null) : null;
    const d2Pos   = d2Result && !d2Result.dnf && !d2Result.notClassified ? (d2Result.finishPosition ?? null) : null;
    const d1Name  = driver1 ? nameMap[driver1.slug] : null;
    const d2Name  = driver2 ? nameMap[driver2.slug] : null;

    const d1Pts = d1Pos != null ? (FINISH_POINTS[d1Pos] ?? 0) : 0;
    const d2Pts = d2Pos != null ? (FINISH_POINTS[d2Pos] ?? 0) : 0;
    const rPts  = d1Pts + d2Pts;

    rows.push({
      round: rr.round,
      flag,
      shortName,
      driver1Pos:  d1Pos,
      driver2Pos:  d2Pos,
      driver1Name: d1Name,
      driver2Name: d2Name,
      rPts,
      tot: rPts,
    });
  }

  const totals = rows.reduce(
    (acc, r) => ({ rPts: acc.rPts + r.rPts, total: acc.total + r.tot }),
    { rPts: 0, total: 0 },
  );

  return NextResponse.json({ rows, totals });
}
