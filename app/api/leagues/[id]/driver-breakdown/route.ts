import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { Asset, RaceCalendar } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { verifyLeagueMembership } from '@/lib/auth-helpers';
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

  const asset = await Asset.findOne({ slug, season: 2026 }).lean() as any;
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  // Load all 2026 driver assets to build slug → {driverNumber, teamName} map.
  // Needed to reconstruct full RaceDriverResult[] / QualifyingDriverResult[] so that
  // teammate comparison in calculateRaceDriverScore / calculateQualifyingDriverScore works.
  const allDriverAssets = await Asset.find({ season: 2026, assetType: 'driver', isActive: true }).lean() as any[];

  const slugToDriver = new Map<string, { driverNumber: number; teamName: string }>();
  for (const d of allDriverAssets) {
    if (d.carNumber && d.team) {
      slugToDriver.set(d.slug as string, { driverNumber: d.carNumber as number, teamName: d.team as string });
    }
  }

  const myDriverInfo = slugToDriver.get(slug) ?? null;

  const calendars = await RaceCalendar.find({ season: 2026 }).sort({ round: 1 }).lean() as any[];

  const rows: any[] = [];

  for (const cal of calendars) {
    const raceArr:       any[] = cal.raceResults       ?? [];
    const qualiArr:      any[] = cal.qualifyingResults ?? [];
    const sprintQualiArr: any[] = cal.sprintQualiResults ?? [];
    const sprintRaceArr:  any[] = cal.sprintRaceResults  ?? [];

    const myRaceEntry  = raceArr.find((e: any)  => e.driverSlug === slug);
    const myQualiEntry = qualiArr.find((e: any) => e.driverSlug === slug);

    // Skip rounds with no data for this driver yet
    if (!myRaceEntry && !myQualiEntry) continue;

    const flag      = COUNTRY_FLAGS[cal.country as string] ?? '🏁';
    const shortName = (cal.country as string) ?? `R${cal.round}`;

    // ── Qualifying ────────────────────────────────────────────────────────────
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

    // ── Sprint points (sprint weekends only) ──────────────────────────────────
    let spPts: number | null = null;
    const mySprintQuali = sprintQualiArr.find((e: any) => e.driverSlug === slug);
    const mySprintRace  = sprintRaceArr.find((e: any)  => e.driverSlug === slug);
    if (mySprintQuali || mySprintRace) {
      spPts = (mySprintQuali?.points ?? 0) + (mySprintRace?.points ?? 0);
    }

    // ── Race ──────────────────────────────────────────────────────────────────
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
      qApprox: false, // real qualifying data from RaceCalendar arrays — never approximate
      rPts:    Math.round(rPts    * 100) / 100,
      spPts,
      flBonus: Math.round(flBonus * 100) / 100,
      btBonus: Math.round(btBonus * 100) / 100,
      pgScore: Math.round(pgScore * 100) / 100,
      total:   Math.round(((qPts ?? 0) + racePts + (spPts ?? 0)) * 100) / 100,
      dnf,
    });
  }

  // Season totals
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

  // Q stage counts
  const qCounts = { Q3: 0, Q2: 0, Q1: 0 };
  for (const r of rows) {
    if (r.qStage === 'Q3')      qCounts.Q3++;
    else if (r.qStage === 'Q2') qCounts.Q2++;
    else if (r.qStage === 'Q1') qCounts.Q1++;
  }

  return NextResponse.json({ rows, totals, qCounts });
}
