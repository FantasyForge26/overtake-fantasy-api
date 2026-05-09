import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { Asset, RaceCalendar } from '@/lib/models';
import { calculateRaceDriverScore, type RaceDriverResult } from '@/lib/scoring/race';
import { calculateQualifyingDriverScore, type QualifyingDriverResult } from '@/lib/scoring/qualifying';

const COUNTRY_FLAGS: Record<string, string> = {
  'Australia': '🇦🇺', 'China': '🇨🇳', 'Japan': '🇯🇵',
  'Bahrain': '🇧🇭', 'Saudi Arabia': '🇸🇦', 'USA': '🇺🇸',
  'Canada': '🇨🇦', 'Monaco': '🇲🇨', 'Spain': '🇪🇸',
  'Austria': '🇦🇹', 'UK': '🇬🇧', 'Belgium': '🇧🇪',
  'Hungary': '🇭🇺', 'Netherlands': '🇳🇱', 'Italy': '🇮🇹',
  'Azerbaijan': '🇦🇿', 'Singapore': '🇸🇬', 'Mexico': '🇲🇽',
  'Brazil': '🇧🇷', 'Qatar': '🇶🇦', 'Abu Dhabi': '🇦🇪',
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { slug } = await params;
  const seasonParam = req.nextUrl.searchParams.get('season');
  const season = seasonParam ? parseInt(seasonParam, 10) : 2026;

  // Gate: only 2026 for now; extend this list as historical data is backfilled
  if (season !== 2026) {
    return NextResponse.json({ error: 'season must be 2026' }, { status: 400 });
  }

  await connectDB();

  const asset = await Asset.findOne({ slug, season }).lean() as any;
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const assetType: string = asset.assetType;

  // For drivers: load all 2026 driver assets to build slug → {driverNumber, teamName} map.
  // This is needed to reconstruct the full RaceDriverResult[] for each round so that
  // calculateRaceDriverScore can do the teammate comparison correctly.
  const allDriverAssets = assetType === 'driver'
    ? await Asset.find({ season, assetType: 'driver', isActive: true }).lean() as any[]
    : [];

  const slugToDriver = new Map<string, { driverNumber: number; teamName: string }>();
  for (const d of allDriverAssets) {
    if (d.carNumber && d.team) {
      slugToDriver.set(d.slug as string, { driverNumber: d.carNumber as number, teamName: d.team as string });
    }
  }

  const myDriverInfo = assetType === 'driver' ? (slugToDriver.get(slug) ?? null) : null;

  // Fetch all calendar rounds for the season, ordered by round
  const calendars = await RaceCalendar.find({ season }).sort({ round: 1 }).lean() as any[];

  const rows: any[] = [];

  for (const cal of calendars) {
    const flag      = COUNTRY_FLAGS[cal.country as string] ?? '🏁';
    const shortName = (cal.country as string) ?? `R${cal.round}`;

    if (assetType === 'driver') {
      const raceArr:  any[] = cal.raceResults       ?? [];
      const qualiArr: any[] = cal.qualifyingResults ?? [];

      const myRaceEntry  = raceArr.find((e: any)  => e.driverSlug === slug);
      const myQualiEntry = qualiArr.find((e: any) => e.driverSlug === slug);

      // Skip rounds with no data for this driver yet
      if (!myRaceEntry && !myQualiEntry) continue;

      // ── Qualifying ────────────────────────────────────────────────────────
      let qPts:   number | null = null;
      let qStage: string | null = null;
      let qPos:   number | null = null;

      if (myQualiEntry && myDriverInfo) {
        qPos   = myQualiEntry.position ?? null;
        qStage = myQualiEntry.stage
          ?? ((qPos ?? 99) <= 10 ? 'Q3' : (qPos ?? 99) <= 15 ? 'Q2' : 'Q1');

        // Reconstruct full QualifyingDriverResult[] so teammate comparison scores correctly
        const qualResults: QualifyingDriverResult[] = qualiArr
          .filter((e: any) => slugToDriver.has(e.driverSlug))
          .map((e: any) => {
            const info = slugToDriver.get(e.driverSlug)!;
            const pos  = e.position ?? 99;
            return {
              driverNumber:  info.driverNumber,
              teamName:      info.teamName,
              finalPosition: e.position ?? null,
              reachedQ2:     pos <= 15,
              reachedQ3:     pos <= 10,
              setLapTime:    true,
              status:        'Qualified' as const,
            };
          });

        const myQualResult = qualResults.find(r => r.driverNumber === myDriverInfo.driverNumber);
        if (myQualResult) {
          qPts = calculateQualifyingDriverScore(myQualResult, qualResults).total;
        }
      }

      // ── Race ──────────────────────────────────────────────────────────────
      let rPts = 0, flBonus = 0, btBonus = 0, pgScore = 0, racePts = 0;
      let dnf  = false;

      if (myRaceEntry && myDriverInfo) {
        // Reconstruct full RaceDriverResult[] so teammate comparison scores correctly
        const raceResults: RaceDriverResult[] = raceArr
          .filter((e: any) => slugToDriver.has(e.driverSlug))
          .map((e: any) => {
            const info  = slugToDriver.get(e.driverSlug)!;
            const isDnf = !!e.notClassified;
            const isDsq = !!e.dsq;
            return {
              driverNumber:   info.driverNumber,
              teamName:       info.teamName,
              finishPosition: isDnf ? null : (e.position ?? null),
              startPosition:  e.startPosition ?? e.position ?? 20,
              status:         isDsq ? 'DSQ' : isDnf ? 'DNF' : 'Finished',
              fastestLap:     !!e.fastestLap,
            } as RaceDriverResult;
          });

        const myRaceResult = raceResults.find(r => r.driverNumber === myDriverInfo.driverNumber);
        if (myRaceResult) {
          const score = calculateRaceDriverScore(myRaceResult, raceResults);
          rPts    = score.positionBonus + score.finishedBonus + score.dsqPenalty;
          flBonus = score.fastestLapBonus;
          btBonus = score.teammateBeatBonus;
          pgScore = score.positionsGainedBonus + score.positionsLostPenalty + score.top10BonusPenalty;
          racePts = score.total;
          dnf     = myRaceResult.status !== 'Finished';
        }
      }

      rows.push({
        round: cal.round, flag, shortName,
        qPts,
        qStage,
        qPos,
        rPts:    Math.round(rPts    * 100) / 100,
        flBonus: Math.round(flBonus * 100) / 100,
        btBonus: Math.round(btBonus * 100) / 100,
        pgScore: Math.round(pgScore * 100) / 100,
        total:   Math.round(((qPts ?? 0) + racePts) * 100) / 100,
        dnf,
      });

    } else {
      // ── Non-driver: single total points per round ─────────────────────────
      let points: number | null = null;

      if (assetType === 'principal') {
        const entry = (cal.principalResults ?? []).find((e: any) => e.principalSlug === slug);
        if (entry) points = entry.points;
      } else if (assetType === 'pitCrew') {
        const entry = (cal.pitCrewResults ?? []).find((e: any) => e.pitCrewSlug === slug);
        if (entry) points = entry.points;
      } else if (assetType === 'powerUnit') {
        const entry = (cal.powerUnitResults ?? []).find((e: any) => e.powerUnitSlug === slug);
        if (entry) points = entry.points;
      }

      // Skip rounds where this asset has no data yet
      if (points === null) continue;

      rows.push({
        round: cal.round, flag, shortName,
        qPts: null, qStage: null, qPos: null,
        rPts: points, flBonus: 0, btBonus: 0, pgScore: 0,
        total: points, dnf: false,
      });
    }
  }

  const totals = rows.reduce(
    (acc, r) => ({
      qPts:    acc.qPts    + (r.qPts ?? 0),
      rPts:    acc.rPts    + r.rPts,
      flBonus: acc.flBonus + r.flBonus,
      btBonus: acc.btBonus + r.btBonus,
      pgScore: acc.pgScore + r.pgScore,
      total:   acc.total   + r.total,
    }),
    { qPts: 0, rPts: 0, flBonus: 0, btBonus: 0, pgScore: 0, total: 0 },
  );

  const qCounts = { Q3: 0, Q2: 0, Q1: 0 };
  for (const r of rows) {
    if (r.qStage === 'Q3')      qCounts.Q3++;
    else if (r.qStage === 'Q2') qCounts.Q2++;
    else if (r.qStage === 'Q1') qCounts.Q1++;
  }

  return NextResponse.json({ rows, totals, qCounts, season });
}
