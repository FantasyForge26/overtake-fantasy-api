import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Asset, RaceResult, RaceCalendar } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { PU_FINISH_POINTS } from '@/lib/otf-calculator';

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

  // Find the requested PU asset to get its manufacturer
  const puAsset = await Asset.findOne({ slug, assetType: 'powerUnit', season: 2026 }).lean() as any;
  if (!puAsset) return NextResponse.json({ error: 'Power unit not found' }, { status: 404 });

  const manufacturer: string = puAsset.manufacturer;
  if (!manufacturer) return NextResponse.json({ error: 'Power unit has no manufacturer' }, { status: 400 });

  // Find all PU assets with the same manufacturer to get all supplied team slugs
  const allPuAssets = await Asset.find({ assetType: 'powerUnit', season: 2026, manufacturer }).lean() as any[];
  const suppliedTeamSlugs = new Set<string>();
  for (const pu of allPuAssets) {
    const teams: string[] = pu.suppliedTeams?.length ? pu.suppliedTeams : [pu.teamSlug];
    for (const t of teams) suppliedTeamSlugs.add(t);
  }

  // Find all drivers across those teams
  const teamDrivers = await Asset.find({
    assetType: 'driver',
    season: 2026,
    teamSlug: { $in: Array.from(suppliedTeamSlugs) },
  }).lean() as any[];
  const driverSlugs = new Set(teamDrivers.map((d: any) => d.slug));

  // Race calendar for flags / country names
  const calendar = await RaceCalendar.find({ season: 2026 }).lean() as any[];
  const calByRound: Record<number, any> = {};
  for (const c of calendar) calByRound[c.round] = c;

  // Scored race results for this league
  const raceResults = await RaceResult.find({ leagueId, season: 2026, raceScored: true })
    .sort({ round: 1 })
    .lean() as any[];

  const rows: any[] = [];

  for (const rr of raceResults) {
    const driverResults: any[] = rr.driverResults ?? [];

    // Collect finish positions for all manufacturer-supplied drivers
    const carPositions: number[] = [];
    for (const dr of driverResults) {
      if (!driverSlugs.has(dr.driverSlug)) continue;
      carPositions.push(dr.dnf || dr.notClassified ? 22 : (dr.finishPosition ?? 22));
    }
    if (carPositions.length === 0) continue;

    const cal = calByRound[rr.round];
    const flag = cal ? (COUNTRY_FLAGS[cal.country] ?? '🏁') : '🏁';
    const shortName = cal?.country ?? `R${rr.round}`;

    const avg = carPositions.reduce((a, b) => a + b, 0) / carPositions.length;
    const avgPos = Math.round(avg);
    const rPts = PU_FINISH_POINTS[avgPos] ?? 0;

    rows.push({
      round:        rr.round,
      flag,
      shortName,
      carCount:     carPositions.length,
      carPositions,
      avgPos,
      rPts,
      tot:          rPts,
    });
  }

  const totals = rows.reduce(
    (acc, r) => ({ rPts: acc.rPts + r.rPts, total: acc.total + r.tot }),
    { rPts: 0, total: 0 },
  );

  return NextResponse.json({ rows, totals, manufacturer });
}
