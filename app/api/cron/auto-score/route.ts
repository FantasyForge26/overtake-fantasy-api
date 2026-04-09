import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Asset, League, Roster, RaceResult, PerformanceSelection, RaceCalendar } from '@/lib/models';
import {
  calculateDriverRaceScore,
  calculateDriverQualifyingScore,
  calculateDriverSprintScore,
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
// Car number ↔ driver slug (2026 grid)
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

function pitCrewCarNumber(slug: string): number {
  const m = slug.match(/-pit-crew-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// ---------------------------------------------------------------------------
// Window: session date falls between 1 h and 4 h before now
// ---------------------------------------------------------------------------

function inWindow(date: Date | string, now: Date): boolean {
  const diff = now.getTime() - new Date(date).getTime();
  return diff >= 60 * 60 * 1000 && diff <= 4 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Shared asset loader
// ---------------------------------------------------------------------------

async function loadSeasonAssets() {
  const all: any[] = await Asset.find({ season: 2026, isActive: true }).lean();

  const driverBySlug = new Map<string, any>(
    all.filter(a => a.assetType === 'driver').map(a => [a.slug, a]),
  );

  const driversByTeam = new Map<string, any[]>();
  for (const a of all) {
    if (a.assetType !== 'driver') continue;
    const arr = driversByTeam.get(a.teamSlug) ?? [];
    arr.push(a);
    driversByTeam.set(a.teamSlug, arr);
  }

  const puBySlug = new Map<string, any>(
    all.filter(a => a.assetType === 'powerUnit').map(a => [a.slug, a]),
  );

  return { driverBySlug, driversByTeam, puBySlug };
}

// ---------------------------------------------------------------------------
// Score qualifying
// ---------------------------------------------------------------------------

async function scoreQualifying(round: number): Promise<number> {
  const session     = await getSession(2026, 'Qualifying', round);
  const qualResults = await getQualifyingResults(session.session_key);
  const qualByNum   = new Map(qualResults.map(r => [r.driverNumber, r]));

  const { driverBySlug, driversByTeam } = await loadSeasonAssets();

  // Pre-compute qualifying score per driver slug
  const driverQualScores = new Map<string, number>();
  for (const [carNumStr, driverSlug] of Object.entries(CAR_TO_SLUG)) {
    const carNumber = Number(carNumStr);
    const driver    = driverBySlug.get(driverSlug);
    if (!driver) continue;

    const qual      = qualByNum.get(carNumber);
    const teammates = (driversByTeam.get(driver.teamSlug) ?? []).filter((d: any) => d.slug !== driverSlug);
    const tmCarNum  = teammates[0] ? SLUG_TO_CAR[teammates[0].slug] : undefined;
    const tmQual    = tmCarNum !== undefined ? qualByNum.get(tmCarNum) : undefined;

    driverQualScores.set(driverSlug, calculateDriverQualifyingScore({
      qualifyingPosition: qual?.position ?? 20,
      qualifyingRound:    qual?.qualifyingRound ?? 'Q1',
      beatenTeammate:     (qual?.position ?? 20) < (tmQual?.position ?? 20),
      didNotQualify:      !qual,
      dsqFromQualifying:  false,
    }));
  }

  const activeLeagues = await League.find({ status: 'active' });
  let scoresCalculated = 0;

  for (const league of activeLeagues) {
    const leagueId = league._id.toString();
    const rosters  = await Roster.find({ leagueId, season: 2026 });
    if (!rosters.length) continue;

    // Load only driver assets needed by rosters
    const assetIdSet = new Set<string>();
    for (const r of rosters) {
      if (r.driver1AssetId) assetIdSet.add(r.driver1AssetId.toString());
      if (r.driver2AssetId) assetIdSet.add(r.driver2AssetId.toString());
    }
    const rosterAssets: any[] = await Asset.find({ _id: { $in: Array.from(assetIdSet) } }).lean();
    const assetById: Record<string, any> = {};
    for (const a of rosterAssets) assetById[a._id.toString()] = a;

    const perfSelections: any[] = await PerformanceSelection.find({ leagueId, season: 2026, round }).lean();
    const perfByUser: Record<string, any> = {};
    for (const ps of perfSelections) perfByUser[ps.userId.toString()] = ps;

    for (const roster of rosters) {
      const userId = roster.userId.toString();
      const perf   = perfByUser[userId];
      const d1     = assetById[roster.driver1AssetId?.toString()];
      const d2     = assetById[roster.driver2AssetId?.toString()];

      let pts = 0;
      if (d1) {
        let p = driverQualScores.get(d1.slug) ?? 0;
        if (perf?.driver1Boost?.toString() === d1._id.toString()) p *= 2;
        pts += p;
      }
      if (d2) {
        let p = driverQualScores.get(d2.slug) ?? 0;
        if (perf?.driver2Boost?.toString() === d2._id.toString()) p *= 2;
        pts += p;
      }

      roster.totalPoints = Math.round(((roster.totalPoints ?? 0) + pts) * 100) / 100;
      roster.updatedAt   = new Date();
      await roster.save();
      scoresCalculated++;
    }

    const ranked = [...rosters].sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
    for (let i = 0; i < ranked.length; i++) {
      ranked[i].seasonRank = i + 1;
      await ranked[i].save();
    }

    await RaceResult.findOneAndUpdate(
      { leagueId, season: 2026, round },
      { $set: { qualifyingScored: true } },
      { upsert: true },
    );
  }

  // Update driver asset qualifying stats
  for (const [carNumStr, driverSlug] of Object.entries(CAR_TO_SLUG)) {
    const carNumber = Number(carNumStr);
    const qual  = qualByNum.get(carNumber);
    const score = driverQualScores.get(driverSlug) ?? 0;

    const asset = await Asset.findOne({ slug: driverSlug, assetType: 'driver', season: 2026 });
    if (!asset) continue;

    asset.qualifyingRaces = (asset.qualifyingRaces ?? 0) + 1;
    asset.q1Count         = (asset.q1Count ?? 0) + 1;
    if (qual?.qualifyingRound === 'Q2' || qual?.qualifyingRound === 'Q3') asset.q2Count = (asset.q2Count ?? 0) + 1;
    if (qual?.qualifyingRound === 'Q3') asset.q3Count = (asset.q3Count ?? 0) + 1;
    asset.totalPoints      = (asset.totalPoints ?? 0) + score;
    asset.avgPointsPerRace = asset.totalPoints / Math.max(1, (asset.racesCompleted ?? 0) + asset.qualifyingRaces);
    asset.otfRating        = calculateOTFRating({
      otfBaseRating:    asset.otfBaseRating,
      racesCompleted:   asset.racesCompleted ?? 0,
      avgPointsPerRace: asset.avgPointsPerRace,
      totalPoints:      asset.totalPoints,
      age:              asset.age,
      teamStrength:     asset.teamStrength,
      dnfCount:         asset.dnfCount ?? 0,
    });
    await asset.save();
  }

  return scoresCalculated;
}

// ---------------------------------------------------------------------------
// Score sprint
// ---------------------------------------------------------------------------

async function scoreSprint(round: number): Promise<number> {
  const session      = await getSession(2026, 'Sprint', round);
  const sprintResults = await getRaceResults(session.session_key);
  const gridPositions = await getGridPositions(session.session_key);

  const sprintByNum = new Map(sprintResults.map(r => [r.driverNumber, r]));
  const gridByNum   = new Map(gridPositions.map(r => [r.driverNumber, r.gridPosition]));

  const { driverBySlug, driversByTeam } = await loadSeasonAssets();

  // Pre-compute sprint score per driver
  const driverSprintScores = new Map<string, number>();
  for (const [carNumStr, driverSlug] of Object.entries(CAR_TO_SLUG)) {
    const carNumber = Number(carNumStr);
    const driver    = driverBySlug.get(driverSlug);
    if (!driver) continue;

    const sprint  = sprintByNum.get(carNumber);
    const gridPos = gridByNum.get(carNumber) ?? 20;

    const teammates = (driversByTeam.get(driver.teamSlug) ?? []).filter((d: any) => d.slug !== driverSlug);
    const tmCarNum  = teammates[0] ? SLUG_TO_CAR[teammates[0].slug] : undefined;
    const tmSprint  = tmCarNum !== undefined ? sprintByNum.get(tmCarNum) : undefined;

    driverSprintScores.set(driverSlug, calculateDriverSprintScore({
      finishPosition:         sprint?.dnf ? 20 : (sprint?.position ?? 20),
      startPosition:          gridPos,
      teammateFinishPosition: tmSprint?.dnf ? 20 : (tmSprint?.position ?? 20),
      fastestLap:             false,
      notClassified:          sprint?.dnf ?? false,
      dsq:                    false,
    }));
  }

  // Principal sprint scores (sum of team drivers' sprint finishes)
  const principalScoreByTeam = new Map<string, number>();
  for (const [teamSlug, drivers] of driversByTeam.entries()) {
    const positions = drivers.map((d: any) => {
      const cn = SLUG_TO_CAR[d.slug];
      const r  = cn !== undefined ? sprintByNum.get(cn) : undefined;
      return r?.dnf ? 20 : (r?.position ?? 20);
    });
    const [p1 = 20, p2 = 20] = positions;
    principalScoreByTeam.set(teamSlug, calculatePrincipalScore(p1, p2));
  }

  const activeLeagues = await League.find({ status: 'active' });
  let scoresCalculated = 0;

  for (const league of activeLeagues) {
    const leagueId = league._id.toString();
    const rosters  = await Roster.find({ leagueId, season: 2026 });
    if (!rosters.length) continue;

    const assetIdSet = new Set<string>();
    for (const r of rosters) {
      for (const field of ['driver1AssetId', 'driver2AssetId', 'principalAssetId'] as const) {
        if (r[field]) assetIdSet.add(r[field].toString());
      }
    }
    const rosterAssets: any[] = await Asset.find({ _id: { $in: Array.from(assetIdSet) } }).lean();
    const assetById: Record<string, any> = {};
    for (const a of rosterAssets) assetById[a._id.toString()] = a;

    const perfSelections: any[] = await PerformanceSelection.find({ leagueId, season: 2026, round }).lean();
    const perfByUser: Record<string, any> = {};
    for (const ps of perfSelections) perfByUser[ps.userId.toString()] = ps;

    for (const roster of rosters) {
      const userId    = roster.userId.toString();
      const perf      = perfByUser[userId];
      const d1        = assetById[roster.driver1AssetId?.toString()];
      const d2        = assetById[roster.driver2AssetId?.toString()];
      const principal = assetById[roster.principalAssetId?.toString()];

      let pts = 0;
      if (d1) {
        let p = driverSprintScores.get(d1.slug) ?? 0;
        if (perf?.driver1Boost?.toString() === d1._id.toString()) p *= 2;
        pts += p;
      }
      if (d2) {
        let p = driverSprintScores.get(d2.slug) ?? 0;
        if (perf?.driver2Boost?.toString() === d2._id.toString()) p *= 2;
        pts += p;
      }
      if (principal) pts += principalScoreByTeam.get(principal.teamSlug) ?? 0;

      roster.totalPoints = Math.round(((roster.totalPoints ?? 0) + pts) * 100) / 100;
      roster.updatedAt   = new Date();
      await roster.save();
      scoresCalculated++;
    }

    const ranked = [...rosters].sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
    for (let i = 0; i < ranked.length; i++) {
      ranked[i].seasonRank = i + 1;
      await ranked[i].save();
    }

    await RaceResult.findOneAndUpdate(
      { leagueId, season: 2026, round },
      { $set: { sprintScored: true } },
      { upsert: true },
    );
  }

  // Update driver asset stats for sprint (totalPoints only — racesCompleted tracks full races)
  for (const [, driverSlug] of Object.entries(CAR_TO_SLUG)) {
    const score = driverSprintScores.get(driverSlug) ?? 0;
    if (!score) continue;

    const asset = await Asset.findOne({ slug: driverSlug, assetType: 'driver', season: 2026 });
    if (!asset) continue;

    asset.totalPoints      = (asset.totalPoints ?? 0) + score;
    asset.avgPointsPerRace = asset.totalPoints / Math.max(1, (asset.racesCompleted ?? 0) + (asset.qualifyingRaces ?? 0));
    asset.otfRating        = calculateOTFRating({
      otfBaseRating:    asset.otfBaseRating,
      racesCompleted:   asset.racesCompleted ?? 0,
      avgPointsPerRace: asset.avgPointsPerRace,
      totalPoints:      asset.totalPoints,
      age:              asset.age,
      teamStrength:     asset.teamStrength,
      dnfCount:         asset.dnfCount ?? 0,
    });
    await asset.save();
  }

  return scoresCalculated;
}

// ---------------------------------------------------------------------------
// Score race (race-only; qualifying is handled separately by scoreQualifying)
// ---------------------------------------------------------------------------

async function scoreRace(round: number): Promise<number> {
  const session       = await getSession(2026, 'Race', round);
  const raceResults   = await getRaceResults(session.session_key);
  const pitStops      = await getPitStopData(session.session_key);
  const gridPositions = await getGridPositions(session.session_key);

  const raceByNum = new Map(raceResults.map(r => [r.driverNumber, r]));
  const gridByNum = new Map(gridPositions.map(r => [r.driverNumber, r.gridPosition]));

  // Pit crew rankings
  const pitMetrics = pitStops
    .filter(p => p.stopTimes.length > 0)
    .map(p => ({
      carNumber: p.driverNumber,
      fastest:   Math.min(...p.stopTimes),
      avg:       p.stopTimes.reduce((a, b) => a + b, 0) / p.stopTimes.length,
    }));
  const fastestRankByNum = new Map(
    [...pitMetrics].sort((a, b) => a.fastest - b.fastest).map((p, i) => [p.carNumber, i + 1]),
  );
  const avgRankByNum = new Map(
    [...pitMetrics].sort((a, b) => a.avg - b.avg).map((p, i) => [p.carNumber, i + 1]),
  );

  const { driverBySlug, driversByTeam, puBySlug } = await loadSeasonAssets();

  // Pre-compute race score per driver
  const driverRaceScores = new Map<string, number>();
  for (const [carNumStr, driverSlug] of Object.entries(CAR_TO_SLUG)) {
    const carNumber = Number(carNumStr);
    const driver    = driverBySlug.get(driverSlug);
    if (!driver) continue;

    const race      = raceByNum.get(carNumber);
    const gridPos   = gridByNum.get(carNumber) ?? 20;
    const teammates = (driversByTeam.get(driver.teamSlug) ?? []).filter((d: any) => d.slug !== driverSlug);
    const tmCarNum  = teammates[0] ? SLUG_TO_CAR[teammates[0].slug] : undefined;
    const tmRace    = tmCarNum !== undefined ? raceByNum.get(tmCarNum) : undefined;

    driverRaceScores.set(driverSlug, calculateDriverRaceScore({
      finishPosition:         race?.dnf ? 20 : (race?.position ?? 20),
      startPosition:          gridPos,
      teammateFinishPosition: tmRace?.dnf ? 20 : (tmRace?.position ?? 20),
      fastestLap:             false,
      notClassified:          race?.dnf ?? false,
      dsq:                    false,
      startedInTop10:         gridPos <= 10,
    }));
  }

  // Pit crew scores
  const pitCrewScoreByNum = new Map<number, number>(
    Object.keys(CAR_TO_SLUG).map(n => [
      Number(n),
      calculatePitCrewScore(fastestRankByNum.get(Number(n)) ?? 0, avgRankByNum.get(Number(n)) ?? 0),
    ]),
  );

  // Power unit scores — grouped by manufacturer so all PU assets with the same
  // manufacturer receive identical points. DNF = 22.
  const puFinishesByManufacturer = new Map<string, number[]>();
  for (const pu of puBySlug.values()) {
    const mfr: string = pu.manufacturer;
    if (!mfr || puFinishesByManufacturer.has(mfr)) continue;

    const allTeams = new Set<string>();
    for (const p of puBySlug.values()) {
      if (p.manufacturer !== mfr) continue;
      const teams: string[] = p.suppliedTeams?.length ? p.suppliedTeams : [p.teamSlug];
      for (const t of teams) allTeams.add(t);
    }

    const finishes: number[] = [];
    for (const teamSlug of allTeams) {
      for (const d of driversByTeam.get(teamSlug) ?? []) {
        const cn = SLUG_TO_CAR[d.slug];
        const r  = cn !== undefined ? raceByNum.get(cn) : undefined;
        finishes.push(r?.dnf ? 22 : (r?.position ?? 22));
      }
    }
    puFinishesByManufacturer.set(mfr, finishes);
  }

  const puScoreByManufacturer = new Map<string, number>();
  for (const [mfr, finishes] of puFinishesByManufacturer.entries()) {
    puScoreByManufacturer.set(mfr, calculatePowerUnitScore(finishes));
  }

  // Principal scores
  const principalScoreByTeam = new Map<string, number>();
  for (const [teamSlug, drivers] of driversByTeam.entries()) {
    const positions = drivers.map((d: any) => {
      const cn = SLUG_TO_CAR[d.slug];
      const r  = cn !== undefined ? raceByNum.get(cn) : undefined;
      return r?.dnf ? 20 : (r?.position ?? 20);
    });
    const [p1 = 20, p2 = 20] = positions;
    principalScoreByTeam.set(teamSlug, calculatePrincipalScore(p1, p2));
  }

  // Canonical result docs (same for every league)
  const driverResultDocs = raceResults.map(r => ({
    driverSlug:       CAR_TO_SLUG[r.driverNumber] ?? `driver-${r.driverNumber}`,
    startPosition:    gridByNum.get(r.driverNumber) ?? 20,
    finishPosition:   r.position,
    fastestLap:       false,
    notClassified:    r.dnf,
    dnf:              r.dnf,
    penalizedSeconds: 0,
  }));
  const pitCrewResultDocs = pitStops
    .filter(p => p.stopTimes.length > 0)
    .map(p => {
      const ds = CAR_TO_SLUG[p.driverNumber];
      const d  = ds ? driverBySlug.get(ds) : undefined;
      if (!d) return null;
      return { pitCrewSlug: `${d.teamSlug}-pit-crew-${p.driverNumber}`, stopTimes: p.stopTimes, fastestStopOverall: p.fastestStopOverall };
    })
    .filter(Boolean);

  const activeLeagues = await League.find({ status: 'active' });
  let scoresCalculated = 0;

  for (const league of activeLeagues) {
    const leagueId = league._id.toString();
    const rosters  = await Roster.find({ leagueId, season: 2026 });
    if (!rosters.length) continue;

    const assetIdSet = new Set<string>();
    for (const r of rosters) {
      for (const field of ['driver1AssetId', 'driver2AssetId', 'principalAssetId', 'pitCrew1AssetId', 'pitCrew2AssetId', 'powerUnitAssetId'] as const) {
        if (r[field]) assetIdSet.add(r[field].toString());
      }
    }
    const rosterAssets: any[] = await Asset.find({ _id: { $in: Array.from(assetIdSet) } }).lean();
    const assetById: Record<string, any> = {};
    for (const a of rosterAssets) assetById[a._id.toString()] = a;

    const perfSelections: any[] = await PerformanceSelection.find({ leagueId, season: 2026, round }).lean();
    const perfByUser: Record<string, any> = {};
    for (const ps of perfSelections) perfByUser[ps.userId.toString()] = ps;

    for (const roster of rosters) {
      const userId    = roster.userId.toString();
      const perf      = perfByUser[userId];
      const d1        = assetById[roster.driver1AssetId?.toString()];
      const d2        = assetById[roster.driver2AssetId?.toString()];
      const principal = assetById[roster.principalAssetId?.toString()];
      const pc1       = assetById[roster.pitCrew1AssetId?.toString()];
      const pc2       = assetById[roster.pitCrew2AssetId?.toString()];
      const pu        = assetById[roster.powerUnitAssetId?.toString()];

      let pts = 0;
      if (d1) {
        let p = driverRaceScores.get(d1.slug) ?? 0;
        if (perf?.driver1Boost?.toString() === d1._id.toString()) p *= 2;
        pts += p;
      }
      if (d2) {
        let p = driverRaceScores.get(d2.slug) ?? 0;
        if (perf?.driver2Boost?.toString() === d2._id.toString()) p *= 2;
        pts += p;
      }
      if (principal) pts += principalScoreByTeam.get(principal.teamSlug) ?? 0;
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
      if (pu) pts += puScoreByManufacturer.get(pu.manufacturer) ?? 0;

      roster.totalPoints = Math.round(((roster.totalPoints ?? 0) + pts) * 100) / 100;
      roster.updatedAt   = new Date();
      await roster.save();
      scoresCalculated++;
    }

    const ranked = [...rosters].sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
    for (let i = 0; i < ranked.length; i++) {
      ranked[i].seasonRank = i + 1;
      await ranked[i].save();
    }

    await RaceResult.findOneAndUpdate(
      { leagueId, season: 2026, round },
      { $set: { raceScored: true, driverResults: driverResultDocs, pitCrewResults: pitCrewResultDocs, enteredAt: new Date(), calculated: true } },
      { upsert: true },
    );
  }

  // Update driver asset race stats
  for (const [carNumStr, driverSlug] of Object.entries(CAR_TO_SLUG)) {
    const carNumber = Number(carNumStr);
    const score = driverRaceScores.get(driverSlug) ?? 0;
    const race  = raceByNum.get(carNumber);

    const asset = await Asset.findOne({ slug: driverSlug, assetType: 'driver', season: 2026 });
    if (!asset) continue;

    asset.racesCompleted = (asset.racesCompleted ?? 0) + 1;
    if (race?.dnf) asset.dnfCount = (asset.dnfCount ?? 0) + 1;
    asset.totalPoints      = (asset.totalPoints ?? 0) + score;
    asset.avgPointsPerRace = asset.totalPoints / Math.max(1, (asset.racesCompleted ?? 0) + (asset.qualifyingRaces ?? 0));
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

  // Update pit crew asset stats
  for (const [carNumStr, driverSlug] of Object.entries(CAR_TO_SLUG)) {
    const carNumber = Number(carNumStr);
    const driver    = driverBySlug.get(driverSlug);
    if (!driver) continue;

    const pitCrew = await Asset.findOne({ slug: `${driver.teamSlug}-pit-crew-${carNumber}`, assetType: 'pitCrew', season: 2026 });
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

  return scoresCalculated;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const authHeader  = req.headers.get('authorization');
  const querySecret = req.nextUrl.searchParams.get('secret');
  const secret      = process.env.CRON_SECRET;
  if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await connectDB();

    const now        = new Date();
    const calEntries = await RaceCalendar.find({ season: 2026, cancelled: false });

    let checked = 0;
    const scored: { round: number; type: string }[] = [];

    for (const entry of calEntries) {
      // Qualifying
      if (entry.qualifyingDate && inWindow(entry.qualifyingDate, now)) {
        checked++;
        const alreadyScored = await RaceResult.findOne({ season: 2026, round: entry.round, qualifyingScored: true });
        if (!alreadyScored) {
          try {
            await scoreQualifying(entry.round);
            scored.push({ round: entry.round, type: 'qualifying' });
          } catch (err: any) {
            console.error(`scoreQualifying round ${entry.round}:`, err.message);
          }
        }
      }

      // Sprint (only on sprint weekends)
      if (entry.isSprint && entry.sprintDate && inWindow(entry.sprintDate, now)) {
        checked++;
        const alreadyScored = await RaceResult.findOne({ season: 2026, round: entry.round, sprintScored: true });
        if (!alreadyScored) {
          try {
            await scoreSprint(entry.round);
            scored.push({ round: entry.round, type: 'sprint' });
          } catch (err: any) {
            console.error(`scoreSprint round ${entry.round}:`, err.message);
          }
        }
      }

      // Race
      if (entry.raceDate && inWindow(entry.raceDate, now)) {
        checked++;
        const alreadyScored = await RaceResult.findOne({ season: 2026, round: entry.round, raceScored: true });
        if (!alreadyScored) {
          try {
            await scoreRace(entry.round);
            scored.push({ round: entry.round, type: 'race' });
          } catch (err: any) {
            console.error(`scoreRace round ${entry.round}:`, err.message);
          }
        }
      }
    }

    return NextResponse.json({ checked, scored });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message, stack: err.stack?.split('\n').slice(0, 5) },
      { status: 500 },
    );
  }
}
