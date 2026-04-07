import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { RaceResult, Asset, RaceCalendar } from '@/lib/models';
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

  // Load the asset
  const asset = await Asset.findOne({ slug }).lean() as any;
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  // Load their teammate (same team, same assetType, different slug)
  const teammate = await Asset.findOne({
    teamSlug: asset.teamSlug,
    assetType: 'driver',
    slug: { $ne: slug },
  }).lean() as any;

  // All race results for this league, sorted by round
  const raceResults = await RaceResult.find({ leagueId, season: 2026 }).sort({ round: 1 }).lean() as any[];

  // Race calendar for flags and short names
  const calendar = await RaceCalendar.find({ season: 2026 }).lean() as any[];
  const calByRound: Record<number, any> = {};
  for (const r of calendar) calByRound[r.round] = r;

  const rows: any[] = [];

  for (const rr of raceResults) {
    const myResult = (rr.driverResults ?? []).find((d: any) => d.driverSlug === slug);
    if (!myResult) continue;

    const cal = calByRound[rr.round];
    const flag = cal ? (COUNTRY_FLAGS[cal.country] ?? '🏁') : '🏁';
    const shortName = cal?.country ?? `R${rr.round}`;

    // DNF / not classified
    if (myResult.notClassified || myResult.dnf) {
      const penalty = myResult.notClassified ? -15 : 0;
      rows.push({ round: rr.round, flag, shortName, qPts: null, rPts: penalty, spPts: null, flBonus: 0, btBonus: 0, pgScore: 0, total: penalty, dnf: true });
      continue;
    }

    const finish = myResult.finishPosition ?? 20;
    const start  = myResult.startPosition  ?? 20;

    const teammateResult = teammate
      ? (rr.driverResults ?? []).find((d: any) => d.driverSlug === teammate.slug)
      : null;
    const teammateFinish = teammateResult?.finishPosition ?? 20;

    const rPts    = (FINISH_POINTS[finish] ?? 0) + 1; // base finish pts + finish bonus
    const flBonus = myResult.fastestLap ? 5 : 0;
    const btBonus = finish < teammateFinish ? 3 : 0;

    const delta = start - finish;
    let pgScore = 0;
    if (delta > 0) {
      pgScore = Math.min(delta * 2, 10);
    } else if (delta < 0) {
      const lost = -delta;
      pgScore = start <= 10 ? -Math.min(lost * 2, 10) : -Math.min(lost, 5);
    }

    const total = rPts + flBonus + btBonus + pgScore;

    rows.push({ round: rr.round, flag, shortName, qPts: null, rPts, spPts: null, flBonus, btBonus, pgScore, total, dnf: false });
  }

  // Season totals
  const totals = rows.reduce(
    (acc, r) => ({
      rPts:    acc.rPts    + r.rPts,
      flBonus: acc.flBonus + r.flBonus,
      btBonus: acc.btBonus + r.btBonus,
      pgScore: acc.pgScore + r.pgScore,
      total:   acc.total   + r.total,
    }),
    { rPts: 0, flBonus: 0, btBonus: 0, pgScore: 0, total: 0 },
  );

  return NextResponse.json({ rows, totals });
}
