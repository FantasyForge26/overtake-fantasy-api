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

  // Find all drivers across those teams for carPositions reconstruction
  const teamDrivers = await Asset.find({
    assetType: 'driver',
    season: 2026,
    teamSlug: { $in: Array.from(suppliedTeamSlugs) },
  }).lean() as any[];
  const driverSlugs = new Set(teamDrivers.map((d: any) => d.slug as string));

  const calendars = await RaceCalendar.find({ season: 2026 }).sort({ round: 1 }).lean() as any[];

  const rows: any[] = [];

  for (const cal of calendars) {
    const puArr:   any[] = cal.powerUnitResults ?? [];
    const raceArr: any[] = cal.raceResults      ?? [];

    // Power unit's pre-computed points for this round (sum across all sessions)
    const myEntries = puArr.filter((e: any) => e.powerUnitSlug === slug);
    if (!myEntries.length) continue;

    const flag      = COUNTRY_FLAGS[cal.country as string] ?? '🏁';
    const shortName = (cal.country as string) ?? `R${cal.round}`;

    // Reconstruct carPositions from RaceCalendar.raceResults for display (DNF = 22)
    const carPositions: number[] = raceArr
      .filter((e: any) => driverSlugs.has(e.driverSlug))
      .map((e: any) => (e.notClassified || e.dsq) ? 22 : (e.position ?? 22));

    const avgPos = carPositions.length > 0
      ? Math.round(carPositions.reduce((a, b) => a + b, 0) / carPositions.length)
      : 0;

    // Per-session point buckets. Old-format entries (no session field) bucket
    // into racePts so legacy data renders sanely.
    const sumPts = (arr: any[]) =>
      Math.round(arr.reduce((s: number, e: any) => s + (e.points ?? 0), 0) * 100) / 100;

    const sqPts   = sumPts(myEntries.filter((e: any) => e.session === 'sprintQuali'));
    const srPts   = sumPts(myEntries.filter((e: any) => e.session === 'sprintRace'));
    const qPts    = sumPts(myEntries.filter((e: any) => e.session === 'qualifying'));
    const racePts = sumPts(myEntries.filter((e: any) => e.session === 'race' || e.session == null));

    const rPts = Math.round((sqPts + srPts + qPts + racePts) * 100) / 100;

    rows.push({
      round:        cal.round,
      flag,
      shortName,
      carCount:     carPositions.length,
      carPositions,
      avgPos,
      sqPts,
      srPts,
      qPts,
      racePts,
      rPts,
      tot:          rPts,
    });
  }

  const totals = rows.reduce(
    (acc, r) => ({
      sqPts:   acc.sqPts   + r.sqPts,
      srPts:   acc.srPts   + r.srPts,
      qPts:    acc.qPts    + r.qPts,
      racePts: acc.racePts + r.racePts,
      rPts:    acc.rPts    + r.rPts,
      total:   acc.total   + r.tot,
    }),
    { sqPts: 0, srPts: 0, qPts: 0, racePts: 0, rPts: 0, total: 0 },
  );

  return NextResponse.json({ rows, totals, manufacturer });
}
