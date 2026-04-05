import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Asset, League, Roster, RaceResult, PerformanceSelection, RaceCalendar } from '@/lib/models';
import {
  calculateDriverRaceScore,
  calculateDriverQualifyingScore,
  calculatePitCrewScore,
  calculatePowerUnitScore,
  calculatePrincipalScore,
  calculateOTFRating,
} from '@/lib/otf-calculator';
import {
  getSession,
  getRaceResults,
  getQualifyingResults,
  getPitStopData,
  getGridPositions,
} from '@/lib/openf1';

// ---------------------------------------------------------------------------
// Car number → driver slug (2026 grid)
// ---------------------------------------------------------------------------

const CAR_TO_SLUG: Record<number, string> = {
  1:  'lando-norris',
  3:  'max-verstappen',
  5:  'gabriel-bortoleto',
  6:  'isack-hadjar',
  10: 'pierre-gasly',
  11: 'sergio-perez',
  12: 'kimi-antonelli',
  14: 'fernando-alonso',
  16: 'charles-leclerc',
  18: 'lance-stroll',
  23: 'alex-albon',
  27: 'nico-hulkenberg',
  30: 'liam-lawson',
  31: 'esteban-ocon',
  41: 'arvid-lindblad',
  43: 'franco-colapinto',
  44: 'lewis-hamilton',
  55: 'carlos-sainz',
  63: 'george-russell',
  77: 'valtteri-bottas',
  81: 'oscar-piastri',
  87: 'oliver-bearman',
};

const SLUG_TO_CAR: Record<string, number> = Object.fromEntries(
  Object.entries(CAR_TO_SLUG).map(([n, s]) => [s, Number(n)]),
);

// Extracts car number from pit crew slug e.g. "mercedes-pit-crew-63" → 63
function pitCrewCarNumber(slug: string): number {
  const m = slug.match(/-pit-crew-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const querySecret = req.nextUrl.searchParams.get('secret');
  const secret = process.env.CRON_SECRET;
  if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const round = parseInt(req.nextUrl.searchParams.get('round') ?? '0', 10);
  if (!round) return NextResponse.json({ error: 'round is required' }, { status: 400 });

  await connectDB();

  const calEntry = await RaceCalendar.findOne({ season: 2026, round });
  if (!calEntry) {
    return NextResponse.json({ error: `No calendar entry for round ${round}` }, { status: 404 });
  }

  // ---------------------------------------------------------------------------
  // Fetch from OpenF1 — race & qualifying session keys in parallel, then data
  // ---------------------------------------------------------------------------

  const [raceSessionKey, qualSessionKey] = await Promise.all([
    getSession(2026, 'Race', round),
    getSession(2026, 'Qualifying', round),
  ]);

  const [raceResults, qualResults, pitStops, gridPositions] = await Promise.all([
    getRaceResults(raceSessionKey),
    getQualifyingResults(qualSessionKey),
    getPitStopData(raceSessionKey),
    getGridPositions(raceSessionKey),
  ]);

  // ---------------------------------------------------------------------------
  // Index raw OpenF1 data by car number
  // ---------------------------------------------------------------------------

  const raceByNum  = new Map(raceResults.map(r  => [r.driverNumber,  r]));
  const qualByNum  = new Map(qualResults.map(r  => [r.driverNumber,  r]));
  const gridByNum  = new Map(gridPositions.map(r => [r.driverNumber,  r.gridPosition]));

  // ---------------------------------------------------------------------------
  // Pit crew rankings: fastestStopRank and avgTimeRank per car number
  // ---------------------------------------------------------------------------

  const pitMetrics = pitStops
    .filter(p => p.stopTimes.length > 0)
    .map(p => ({
      carNumber: p.driverNumber,
      fastest:   Math.min(...p.stopTimes),
      avg:       p.stopTimes.reduce((a, b) => a + b, 0) / p.stopTimes.length,
    }));

  const byFastest = [...pitMetrics].sort((a, b) => a.fastest - b.fastest);
  const byAvg     = [...pitMetrics].sort((a, b) => a.avg - b.avg);

  const fastestRankByNum = new Map(byFastest.map((p, i) => [p.carNumber, i + 1]));
  const avgRankByNum     = new Map(byAvg.map((p, i) => [p.carNumber, i + 1]));

  // ---------------------------------------------------------------------------
  // Load all active season assets
  // ---------------------------------------------------------------------------

  const allAssets: any[] = await Asset.find({ season: 2026, isActive: true }).lean();

  const driverBySlug   = new Map<string, any>(allAssets.filter(a => a.assetType === 'driver').map(a => [a.slug, a]));
  const pitCrewBySlug  = new Map<string, any>(allAssets.filter(a => a.assetType === 'pitCrew').map(a => [a.slug, a]));
  const puBySlug       = new Map<string, any>(allAssets.filter(a => a.assetType === 'powerUnit').map(a => [a.slug, a]));

  // teamSlug → both drivers (for teammate lookups and principal/PU scoring)
  const driversByTeam = new Map<string, any[]>();
  for (const a of allAssets) {
    if (a.assetType !== 'driver') continue;
    const arr = driversByTeam.get(a.teamSlug) ?? [];
    arr.push(a);
    driversByTeam.set(a.teamSlug, arr);
  }

  // ---------------------------------------------------------------------------
  // Pre-compute per-driver race + qualifying scores
  // ---------------------------------------------------------------------------

  const driverScores = new Map<string, { race: number; qual: number }>();

  for (const [carNumStr, driverSlug] of Object.entries(CAR_TO_SLUG)) {
    const carNumber = Number(carNumStr);
    const driver = driverBySlug.get(driverSlug);
    if (!driver) continue;

    const race    = raceByNum.get(carNumber);
    const qual    = qualByNum.get(carNumber);
    const gridPos = gridByNum.get(carNumber) ?? 20;

    const teammates = (driversByTeam.get(driver.teamSlug) ?? []).filter((d: any) => d.slug !== driverSlug);
    const tmCarNum  = teammates[0] ? SLUG_TO_CAR[teammates[0].slug] : undefined;
    const tmRace    = tmCarNum !== undefined ? raceByNum.get(tmCarNum) : undefined;
    const tmQual    = tmCarNum !== undefined ? qualByNum.get(tmCarNum) : undefined;

    const finishPos  = race?.dnf ? 20 : (race?.position ?? 20);
    const tmFinish   = tmRace?.dnf ? 20 : (tmRace?.position ?? 20);

    const raceScore = calculateDriverRaceScore({
      finishPosition:         finishPos,
      startPosition:          gridPos,
      teammateFinishPosition: tmFinish,
      fastestLap:             false,
      notClassified:          race?.dnf ?? false,
      dsq:                    false,
      startedInTop10:         gridPos <= 10,
    });

    const qualScore = calculateDriverQualifyingScore({
      qualifyingPosition: qual?.position ?? 20,
      qualifyingRound:    qual?.qualifyingRound ?? 'Q1',
      beatenTeammate:     (qual?.position ?? 20) < (tmQual?.position ?? 20),
      didNotQualify:      !qual,
      dsqFromQualifying:  false,
    });

    driverScores.set(driverSlug, { race: raceScore, qual: qualScore });
  }

  // ---------------------------------------------------------------------------
  // Pre-compute pit crew, power unit, and principal scores
  // ---------------------------------------------------------------------------

  // Pit crew score per car number
  const pitCrewScoreByNum = new Map<number, number>();
  for (const carNumber of Object.keys(CAR_TO_SLUG).map(Number)) {
    const fRank = fastestRankByNum.get(carNumber) ?? 0;
    const aRank = avgRankByNum.get(carNumber) ?? 0;
    pitCrewScoreByNum.set(carNumber, calculatePitCrewScore(fRank, aRank));
  }

  // Power unit score per PU slug (average finish of all supplied teams)
  const puScoreBySlug = new Map<string, number>();
  for (const pu of puBySlug.values()) {
    const suppliedTeams: string[] = pu.suppliedTeams?.length ? pu.suppliedTeams : [pu.teamSlug];
    const finishes: number[] = [];
    for (const teamSlug of suppliedTeams) {
      for (const d of driversByTeam.get(teamSlug) ?? []) {
        const cn   = SLUG_TO_CAR[d.slug];
        const race = cn !== undefined ? raceByNum.get(cn) : undefined;
        finishes.push(race?.dnf ? 20 : (race?.position ?? 20));
      }
    }
    if (finishes.length > 0) {
      const avg = finishes.reduce((a, b) => a + b, 0) / finishes.length;
      puScoreBySlug.set(pu.slug, calculatePowerUnitScore(avg));
    }
  }

  // Principal score per teamSlug (sum of both team drivers' finish positions)
  const principalScoreByTeam = new Map<string, number>();
  for (const [teamSlug, drivers] of driversByTeam.entries()) {
    const positions = drivers.map((d: any) => {
      const cn   = SLUG_TO_CAR[d.slug];
      const race = cn !== undefined ? raceByNum.get(cn) : undefined;
      return race?.dnf ? 20 : (race?.position ?? 20);
    });
    const [p1 = 20, p2 = 20] = positions;
    principalScoreByTeam.set(teamSlug, calculatePrincipalScore(p1, p2));
  }

  // ---------------------------------------------------------------------------
  // Build canonical result docs for RaceResult (same across all leagues)
  // ---------------------------------------------------------------------------

  const driverResultDocs = raceResults.map(r => ({
    driverSlug:     CAR_TO_SLUG[r.driverNumber] ?? `driver-${r.driverNumber}`,
    startPosition:  gridByNum.get(r.driverNumber) ?? 20,
    finishPosition: r.position,
    fastestLap:     false,
    notClassified:  r.dnf,
    dnf:            r.dnf,
    penalizedSeconds: 0,
  }));

  const pitCrewResultDocs = pitStops
    .filter(p => p.stopTimes.length > 0)
    .map(p => {
      const driverSlug = CAR_TO_SLUG[p.driverNumber];
      if (!driverSlug) return null;
      const driver = driverBySlug.get(driverSlug);
      if (!driver) return null;
      return {
        pitCrewSlug:        `${driver.teamSlug}-pit-crew-${p.driverNumber}`,
        stopTimes:          p.stopTimes,
        fastestStopOverall: p.fastestStopOverall,
      };
    })
    .filter(Boolean);

  // ---------------------------------------------------------------------------
  // Score every active league
  // ---------------------------------------------------------------------------

  const activeLeagues = await League.find({ status: 'active' });
  let scoresCalculated = 0;

  for (const league of activeLeagues) {
    const leagueId = league._id.toString();

    const rosters = await Roster.find({ leagueId, season: 2026 });
    if (!rosters.length) continue;

    // Load all assets referenced by rosters in one query
    const assetIdSet = new Set<string>();
    for (const r of rosters) {
      for (const field of ['driver1AssetId', 'driver2AssetId', 'principalAssetId', 'pitCrew1AssetId', 'pitCrew2AssetId', 'powerUnitAssetId'] as const) {
        if (r[field]) assetIdSet.add(r[field].toString());
      }
    }
    const rosterAssets: any[] = await Asset.find({ _id: { $in: Array.from(assetIdSet) } }).lean();
    const assetById: Record<string, any> = {};
    for (const a of rosterAssets) assetById[a._id.toString()] = a;

    // Load performance selections for this round
    const perfSelections: any[] = await PerformanceSelection.find({ leagueId, season: 2026, round }).lean();
    const perfByUser: Record<string, any> = {};
    for (const ps of perfSelections) perfByUser[ps.userId.toString()] = ps;

    for (const roster of rosters) {
      const userId = roster.userId.toString();
      const perf   = perfByUser[userId];

      const d1        = assetById[roster.driver1AssetId?.toString()];
      const d2        = assetById[roster.driver2AssetId?.toString()];
      const principal = assetById[roster.principalAssetId?.toString()];
      const pc1       = assetById[roster.pitCrew1AssetId?.toString()];
      const pc2       = assetById[roster.pitCrew2AssetId?.toString()];
      const pu        = assetById[roster.powerUnitAssetId?.toString()];

      let pts = 0;

      // Drivers (race + qualifying combined, boost applies to total)
      if (d1) {
        const s = driverScores.get(d1.slug);
        if (s) {
          let p = s.race + s.qual;
          if (perf?.driver1Boost?.toString() === d1._id.toString()) p *= 2;
          pts += p;
        }
      }
      if (d2) {
        const s = driverScores.get(d2.slug);
        if (s) {
          let p = s.race + s.qual;
          if (perf?.driver2Boost?.toString() === d2._id.toString()) p *= 2;
          pts += p;
        }
      }

      // Principal
      if (principal) {
        pts += principalScoreByTeam.get(principal.teamSlug) ?? 0;
      }

      // Pit crews
      if (pc1) {
        const cn = pc1.carNumber ?? pitCrewCarNumber(pc1.slug ?? '');
        let p = pitCrewScoreByNum.get(cn) ?? 0;
        if (perf?.pitCrew1Boost?.toString() === pc1._id.toString()) p *= 2;
        pts += p;
      }
      if (pc2) {
        const cn = pc2.carNumber ?? pitCrewCarNumber(pc2.slug ?? '');
        let p = pitCrewScoreByNum.get(cn) ?? 0;
        if (perf?.pitCrew2Boost?.toString() === pc2._id.toString()) p *= 2;
        pts += p;
      }

      // Power unit
      if (pu) {
        pts += puScoreBySlug.get(pu.slug) ?? 0;
      }

      roster.totalPoints = (roster.totalPoints ?? 0) + Math.round(pts * 100) / 100;
      roster.updatedAt   = new Date();
      await roster.save();
      scoresCalculated++;
    }

    // Refresh season ranks within this league
    const ranked = [...rosters].sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
    for (let i = 0; i < ranked.length; i++) {
      ranked[i].seasonRank = i + 1;
      await ranked[i].save();
    }

    // Upsert RaceResult for this league
    await RaceResult.findOneAndUpdate(
      { leagueId, season: 2026, round },
      {
        leagueId,
        season:          2026,
        round,
        driverResults:   driverResultDocs,
        pitCrewResults:  pitCrewResultDocs,
        enteredAt:       new Date(),
        calculated:      true,
      },
      { upsert: true },
    );
  }

  // ---------------------------------------------------------------------------
  // Update driver and pit crew asset stats (global — not per league)
  // ---------------------------------------------------------------------------

  for (const [carNumStr, driverSlug] of Object.entries(CAR_TO_SLUG)) {
    const carNumber = Number(carNumStr);
    const s   = driverScores.get(driverSlug);
    if (!s) continue;

    const qual = qualByNum.get(carNumber);
    const race = raceByNum.get(carNumber);

    const asset = await Asset.findOne({ slug: driverSlug, assetType: 'driver', season: 2026 });
    if (!asset) continue;

    asset.racesCompleted  = (asset.racesCompleted ?? 0) + 1;
    asset.qualifyingRaces = (asset.qualifyingRaces ?? 0) + 1;
    asset.q1Count         = (asset.q1Count ?? 0) + 1;
    if (qual?.qualifyingRound === 'Q2' || qual?.qualifyingRound === 'Q3') {
      asset.q2Count = (asset.q2Count ?? 0) + 1;
    }
    if (qual?.qualifyingRound === 'Q3') {
      asset.q3Count = (asset.q3Count ?? 0) + 1;
    }
    if (race?.dnf) asset.dnfCount = (asset.dnfCount ?? 0) + 1;

    asset.totalPoints     = (asset.totalPoints ?? 0) + s.race + s.qual;
    asset.avgPointsPerRace = asset.totalPoints / (asset.racesCompleted + asset.qualifyingRaces);
    asset.otfRating        = calculateOTFRating({
      otfBaseRating:    asset.otfBaseRating,
      racesCompleted:   asset.racesCompleted,
      avgPointsPerRace: asset.avgPointsPerRace,
      totalPoints:      asset.totalPoints,
      age:              asset.age,
      teamStrength:     asset.teamStrength,
      dnfCount:         asset.dnfCount ?? 0,
    });

    await asset.save();
  }

  for (const [carNumStr, driverSlug] of Object.entries(CAR_TO_SLUG)) {
    const carNumber  = Number(carNumStr);
    const driver     = driverBySlug.get(driverSlug);
    if (!driver) continue;

    const pitCrewSlug = `${driver.teamSlug}-pit-crew-${carNumber}`;
    const pitCrew     = await Asset.findOne({ slug: pitCrewSlug, assetType: 'pitCrew', season: 2026 });
    if (!pitCrew) continue;

    const score = pitCrewScoreByNum.get(carNumber) ?? 0;
    pitCrew.racesCompleted   = (pitCrew.racesCompleted ?? 0) + 1;
    pitCrew.totalPoints      = (pitCrew.totalPoints ?? 0) + score;
    pitCrew.avgPointsPerRace = pitCrew.totalPoints / pitCrew.racesCompleted;
    pitCrew.otfRating        = calculateOTFRating({
      otfBaseRating:    pitCrew.otfBaseRating,
      racesCompleted:   pitCrew.racesCompleted,
      avgPointsPerRace: pitCrew.avgPointsPerRace,
      totalPoints:      pitCrew.totalPoints,
      teamStrength:     pitCrew.teamStrength,
      dnfCount:         0,
    });

    await pitCrew.save();
  }

  return NextResponse.json({ success: true, round, scoresCalculated });
}
