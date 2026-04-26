import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Asset, RaceResult, RaceCalendar } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { verifyLeagueMembership } from '@/lib/auth-helpers';
import { calculatePitCrewScore } from '@/lib/otf-calculator';

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

  const pitCrew = await Asset.findOne({ slug, assetType: 'pitCrew' }).lean() as any;
  if (!pitCrew) return NextResponse.json({ error: 'Pit crew not found' }, { status: 404 });

  // Race calendar for flags / country names
  const calendar = await RaceCalendar.find({ season: 2026 }).lean() as any[];
  const calByRound: Record<number, any> = {};
  for (const c of calendar) calByRound[c.round] = c;

  // Scored races for this league
  const raceResults = await RaceResult.find({ leagueId, season: 2026, raceScored: true })
    .sort({ round: 1 })
    .lean() as any[];

  // Also fetch all races to rank pit crews each round (need all pitCrewResults per round)
  const allRaceResults = await RaceResult.find({ leagueId, season: 2026, raceScored: true })
    .sort({ round: 1 })
    .lean() as any[];

  const rows: any[] = [];

  for (const rr of allRaceResults) {
    const pitCrewResults: any[] = rr.pitCrewResults ?? [];

    // Find this pit crew's entry
    const myEntry = pitCrewResults.find((p: any) => p.pitCrewSlug === slug);
    if (!myEntry || !myEntry.stopTimes?.length) continue;

    const cal = calByRound[rr.round];
    const flag = cal ? (COUNTRY_FLAGS[cal.country] ?? '🏁') : '🏁';
    const shortName = cal?.country ?? `R${rr.round}`;

    const stopTimes: number[] = myEntry.stopTimes;
    const stopCount = stopTimes.length;
    const fastestStop = Math.min(...stopTimes);
    const avgStopTime = Math.round((stopTimes.reduce((a: number, b: number) => a + b, 0) / stopCount) * 1000) / 1000;
    const wasOverallFastest: boolean = myEntry.fastestStopOverall ?? false;

    // Rank all crews this round to compute rPts
    const allStopsBySlug: Record<string, number[]> = {};
    for (const p of pitCrewResults) {
      if (p.stopTimes?.length) allStopsBySlug[p.pitCrewSlug] = p.stopTimes;
    }
    const slugsWithData = Object.keys(allStopsBySlug);

    const fastestBySlug: Record<string, number> = {};
    const avgBySlug: Record<string, number> = {};
    for (const s of slugsWithData) {
      const times = allStopsBySlug[s];
      fastestBySlug[s] = Math.min(...times);
      avgBySlug[s] = times.reduce((a: number, b: number) => a + b, 0) / times.length;
    }

    const fastestRanking = [...slugsWithData].sort((a, b) => fastestBySlug[a] - fastestBySlug[b]);
    const avgRanking     = [...slugsWithData].sort((a, b) => avgBySlug[a]     - avgBySlug[b]);

    const fastestRank = fastestRanking.indexOf(slug) + 1;
    const avgRank     = avgRanking.indexOf(slug) + 1;
    const rPts = fastestRank > 0 ? calculatePitCrewScore(fastestRank, avgRank) : 0;

    rows.push({
      round: rr.round,
      flag,
      shortName,
      stopCount,
      avgStopTime,
      fastestStop,
      wasOverallFastest,
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
