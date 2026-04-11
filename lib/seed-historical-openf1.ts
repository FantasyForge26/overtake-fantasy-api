/**
 * Seed historical race data for 2023 and 2024 seasons using OpenF1 API.
 *
 * Usage:
 *   MONGODB_URI='...' npx ts-node --compiler-options '{"module":"commonjs"}' lib/seed-historical-openf1.ts
 *   MONGODB_URI='...' npx ts-node --compiler-options '{"module":"commonjs"}' lib/seed-historical-openf1.ts --season 2024
 */

import mongoose from 'mongoose';
import { connectDB } from './db';
import { Asset, HistoricalRaceBreakdown, HistoricalSeason } from './models';
import {
  calculateDriverRaceScore,
  calculateDriverQualifyingScore,
  calculatePitCrewScore,
  calculatePowerUnitScore,
  calculatePrincipalScore,
} from './otf-calculator';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const seasonArg = args.includes('--season') ? parseInt(args[args.indexOf('--season') + 1]) : null;
const SEASONS = seasonArg ? [seasonArg] : [2023, 2024];

// ---------------------------------------------------------------------------
// Rate-limited OpenF1 fetch with exponential backoff on 429
// ---------------------------------------------------------------------------
const BASE_URL = 'https://api.openf1.org/v1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function openf1Fetch<T>(path: string, params: Record<string, string | number> = {}): Promise<T[]> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}${k.endsWith('=') ? '' : '='}${encodeURIComponent(String(v))}`)
    .join('&');
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ''}`;

  let delay = 15000;
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(400);
    const res = await fetch(url);
    if (res.status === 429) {
      console.warn(`  [429] rate limited, waiting ${delay / 1000}s…`);
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (!res.ok) throw new Error(`OpenF1 ${res.status}: GET ${url}`);
    return res.json() as Promise<T[]>;
  }
  throw new Error(`OpenF1 max retries exceeded: GET ${url}`);
}

// ---------------------------------------------------------------------------
// OpenF1 data fetchers
// ---------------------------------------------------------------------------

interface OF1Meeting { meeting_key: number; meeting_name: string; date_start: string; year: number; }
interface OF1Session { session_key: number; session_type: string; session_name: string; date_start: string; meeting_key: number; }
interface OF1Position { session_key: number; driver_number: number; position: number; date: string; }
interface OF1Lap { session_key: number; driver_number: number; lap_number: number; lap_duration: number | null; date_start: string; is_pit_out_lap: boolean; }
interface OF1Pit { session_key: number; driver_number: number; pit_duration: number | null; lap_number: number; date: string; }
interface OF1Driver { session_key: number; driver_number: number; full_name: string; name_acronym: string; team_name: string; }

async function getMeetings(year: number): Promise<OF1Meeting[]> {
  const meetings = await openf1Fetch<OF1Meeting>('/meetings', { year });
  return meetings
    .filter(m => !/test/i.test(m.meeting_name))
    .sort((a, b) => new Date(a.date_start).getTime() - new Date(b.date_start).getTime());
}

async function getSessionForMeeting(meetingKey: number, sessionType: string): Promise<OF1Session | null> {
  const sessions = await openf1Fetch<OF1Session>('/sessions', {
    meeting_key: meetingKey,
    session_type: sessionType,
  });
  return sessions[0] ?? null;
}

async function fetchDriversForSession(sessionKey: number): Promise<OF1Driver[]> {
  return openf1Fetch<OF1Driver>('/drivers', { session_key: sessionKey });
}

async function fetchRaceResults(sessionKey: number): Promise<Array<{ driverNumber: number; position: number; dnf: boolean }>> {
  const positions = await openf1Fetch<OF1Position>('/position', { session_key: sessionKey });
  const laps = await openf1Fetch<OF1Lap>('/laps', { session_key: sessionKey });

  const lastPos = new Map<number, { position: number; date: string }>();
  for (const p of positions) {
    const cur = lastPos.get(p.driver_number);
    if (!cur || p.date > cur.date) lastPos.set(p.driver_number, { position: p.position, date: p.date });
  }

  const maxLap = new Map<number, number>();
  for (const lap of laps) {
    const cur = maxLap.get(lap.driver_number) ?? 0;
    if (lap.lap_number > cur) maxLap.set(lap.driver_number, lap.lap_number);
  }
  const raceLaps = maxLap.size > 0 ? Math.max(...maxLap.values()) : 0;

  return Array.from(lastPos.entries()).map(([driverNumber, { position }]) => ({
    driverNumber,
    position,
    dnf: (maxLap.get(driverNumber) ?? 0) < raceLaps - 1,
  })).sort((a, b) => a.position - b.position);
}

async function fetchQualifyingResults(sessionKey: number): Promise<Array<{ driverNumber: number; position: number; qualifyingRound: 'Q1' | 'Q2' | 'Q3' }>> {
  const laps = await openf1Fetch<OF1Lap>('/laps', { session_key: sessionKey });

  const bestLap = new Map<number, number>();
  for (const lap of laps) {
    if (lap.lap_duration == null || lap.is_pit_out_lap) continue;
    const cur = bestLap.get(lap.driver_number);
    if (cur === undefined || lap.lap_duration < cur) bestLap.set(lap.driver_number, lap.lap_duration);
  }

  return Array.from(bestLap.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([driverNumber], idx) => {
      const position = idx + 1;
      const qualifyingRound: 'Q1' | 'Q2' | 'Q3' = position <= 10 ? 'Q3' : position <= 15 ? 'Q2' : 'Q1';
      return { driverNumber, position, qualifyingRound };
    });
}

async function fetchPitData(sessionKey: number): Promise<Array<{ driverNumber: number; stopTimes: number[]; fastestStopOverall: boolean }>> {
  const pits = await openf1Fetch<OF1Pit>('/pit', { session_key: sessionKey });

  const byDriver = new Map<number, number[]>();
  for (const p of pits) {
    if (p.pit_duration == null) continue;
    if (p.pit_duration < 15 || p.pit_duration > 60) continue;
    const stopTime = Math.round(p.pit_duration * 100) / 100;
    const stops = byDriver.get(p.driver_number) ?? [];
    stops.push(stopTime);
    byDriver.set(p.driver_number, stops);
  }

  let fastestTime = Infinity;
  let fastestDriver = -1;
  for (const [driverNumber, stops] of byDriver.entries()) {
    const min = Math.min(...stops);
    if (min < fastestTime) { fastestTime = min; fastestDriver = driverNumber; }
  }

  return Array.from(byDriver.entries()).map(([driverNumber, stopTimes]) => ({
    driverNumber,
    stopTimes,
    fastestStopOverall: driverNumber === fastestDriver,
  }));
}

async function fetchGridPositions(sessionKey: number): Promise<Array<{ driverNumber: number; gridPosition: number }>> {
  const sessions = await openf1Fetch<OF1Session>('/sessions', { session_key: sessionKey });
  if (!sessions.length) return [];

  const { date_start } = sessions[0];
  const cutoff = new Date(new Date(date_start).getTime() + 5 * 60 * 1000).toISOString();

  const positions = await openf1Fetch<OF1Position>('/position', {
    session_key: sessionKey,
    'date>=': date_start,
    'date<=': cutoff,
  });

  const gridMap = new Map<number, { position: number; date: string }>();
  for (const p of positions) {
    const cur = gridMap.get(p.driver_number);
    if (!cur || p.date < cur.date) gridMap.set(p.driver_number, { position: p.position, date: p.date });
  }

  return Array.from(gridMap.entries())
    .map(([driverNumber, { position }]) => ({ driverNumber, gridPosition: position }))
    .sort((a, b) => a.gridPosition - b.gridPosition);
}

// ---------------------------------------------------------------------------
// Name normalisation helpers
// ---------------------------------------------------------------------------

function normaliseName(name: string): string {
  return name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z ]/g, '')
    .trim();
}

/** Build a map: normalised last name → asset slug, from our 2026 assets */
function buildNameSlugMap(assets: any[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of assets) {
    const parts = (a.name as string).split(' ');
    const lastName = normaliseName(parts[parts.length - 1]);
    map.set(lastName, a.slug as string);
    // also index full name
    map.set(normaliseName(a.name), a.slug as string);
  }
  return map;
}

/** Resolve OpenF1 full_name to an asset slug */
function resolveDriverSlug(fullName: string, nameSlugMap: Map<string, string>): string | null {
  const norm = normaliseName(fullName);
  if (nameSlugMap.has(norm)) return nameSlugMap.get(norm)!;
  // try last name only
  const parts = norm.split(' ');
  const last = parts[parts.length - 1];
  return nameSlugMap.get(last) ?? null;
}

// ---------------------------------------------------------------------------
// Team name → principal/pitCrew/powerUnit slug helpers
// ---------------------------------------------------------------------------

// Map OpenF1 team names to our asset slug prefixes
const TEAM_SLUG_MAP: Record<string, { principal: string; pitCrew: string; powerUnit: string }> = {
  'red bull racing':          { principal: 'red-bull-principal',          pitCrew: 'red-bull-pit-crew',          powerUnit: 'honda-rbpt-pu' },
  'oracle red bull racing':   { principal: 'red-bull-principal',          pitCrew: 'red-bull-pit-crew',          powerUnit: 'honda-rbpt-pu' },
  'mercedes':                 { principal: 'mercedes-principal',          pitCrew: 'mercedes-pit-crew',          powerUnit: 'mercedes-pu' },
  'mercedes-amg petronas f1 team': { principal: 'mercedes-principal',    pitCrew: 'mercedes-pit-crew',          powerUnit: 'mercedes-pu' },
  'ferrari':                  { principal: 'ferrari-principal',           pitCrew: 'ferrari-pit-crew',           powerUnit: 'ferrari-pu' },
  'scuderia ferrari':         { principal: 'ferrari-principal',           pitCrew: 'ferrari-pit-crew',           powerUnit: 'ferrari-pu' },
  'mclaren':                  { principal: 'mclaren-principal',           pitCrew: 'mclaren-pit-crew',           powerUnit: 'mercedes-pu' },
  'mclaren f1 team':          { principal: 'mclaren-principal',           pitCrew: 'mclaren-pit-crew',           powerUnit: 'mercedes-pu' },
  'aston martin':             { principal: 'aston-martin-principal',      pitCrew: 'aston-martin-pit-crew',      powerUnit: 'honda-rbpt-pu' },
  'aston martin aramco cognizant f1 team': { principal: 'aston-martin-principal', pitCrew: 'aston-martin-pit-crew', powerUnit: 'honda-rbpt-pu' },
  'aston martin aramco f1 team': { principal: 'aston-martin-principal',   pitCrew: 'aston-martin-pit-crew',      powerUnit: 'honda-rbpt-pu' },
  'alpine':                   { principal: 'alpine-principal',            pitCrew: 'alpine-pit-crew',            powerUnit: 'renault-pu' },
  'alpine f1 team':           { principal: 'alpine-principal',            pitCrew: 'alpine-pit-crew',            powerUnit: 'renault-pu' },
  'williams':                 { principal: 'williams-principal',          pitCrew: 'williams-pit-crew',          powerUnit: 'mercedes-pu' },
  'williams racing':          { principal: 'williams-principal',          pitCrew: 'williams-pit-crew',          powerUnit: 'mercedes-pu' },
  'alphatauri':               { principal: 'rb-principal',                pitCrew: 'rb-pit-crew',                powerUnit: 'honda-rbpt-pu' },
  'scuderia alphatauri':      { principal: 'rb-principal',                pitCrew: 'rb-pit-crew',                powerUnit: 'honda-rbpt-pu' },
  'rb':                       { principal: 'rb-principal',                pitCrew: 'rb-pit-crew',                powerUnit: 'honda-rbpt-pu' },
  'visa cash app rb f1 team': { principal: 'rb-principal',                pitCrew: 'rb-pit-crew',                powerUnit: 'honda-rbpt-pu' },
  'alfa romeo':               { principal: 'sauber-principal',            pitCrew: 'sauber-pit-crew',            powerUnit: 'ferrari-pu' },
  'alfa romeo f1 team stake': { principal: 'sauber-principal',            pitCrew: 'sauber-pit-crew',            powerUnit: 'ferrari-pu' },
  'sauber':                   { principal: 'sauber-principal',            pitCrew: 'sauber-pit-crew',            powerUnit: 'ferrari-pu' },
  'stake f1 team kick sauber':{ principal: 'sauber-principal',            pitCrew: 'sauber-pit-crew',            powerUnit: 'ferrari-pu' },
  'haas':                     { principal: 'haas-principal',              pitCrew: 'haas-pit-crew',              powerUnit: 'ferrari-pu' },
  'haas f1 team':             { principal: 'haas-principal',              pitCrew: 'haas-pit-crew',              powerUnit: 'ferrari-pu' },
  'moneygramm haas f1 team':  { principal: 'haas-principal',              pitCrew: 'haas-pit-crew',              powerUnit: 'ferrari-pu' },
  'moneygram haas f1 team':   { principal: 'haas-principal',              pitCrew: 'haas-pit-crew',              powerUnit: 'ferrari-pu' },
};

function resolveTeamSlugs(teamName: string): { principal: string; pitCrew: string; powerUnit: string } | null {
  const key = teamName.toLowerCase().trim();
  return TEAM_SLUG_MAP[key] ?? null;
}

// For per-car pit crew slug: team slug prefix + car number
function pitCrewSlugForCar(teamName: string, carNumber: number): string | null {
  const slugs = resolveTeamSlugs(teamName);
  if (!slugs) return null;
  const prefix = slugs.pitCrew.replace(/-pit-crew$/, '');
  return `${prefix}-pit-crew-${carNumber}`;
}

// ---------------------------------------------------------------------------
// Upsert helpers
// ---------------------------------------------------------------------------

async function upsertBreakdown(doc: Record<string, any>) {
  await HistoricalRaceBreakdown.findOneAndUpdate(
    { assetSlug: doc.assetSlug, season: doc.season, round: doc.round },
    { $set: doc },
    { upsert: true },
  );
}

interface SeasonAccum {
  assetSlug: string;
  assetType: string;
  season: number;
  team?: string;
  racesCompleted: number;
  wins: number;
  podiums: number;
  pointsFinishes: number;
  dnfCount: number;
  totalPoints: number;
  q3Count: number;
  qualifyingRaces: number;
  qualifyingPositions: number[];
  pitStopTimes: number[];
  fastestStopCount: number;
}

async function flushSeasonAccum(accum: SeasonAccum) {
  const avgPointsPerRace = accum.racesCompleted > 0
    ? Math.round((accum.totalPoints / accum.racesCompleted) * 100) / 100
    : 0;
  const avgQualifyingPosition = accum.qualifyingPositions.length > 0
    ? Math.round((accum.qualifyingPositions.reduce((a, b) => a + b, 0) / accum.qualifyingPositions.length) * 100) / 100
    : 0;
  const avgPitStopTime = accum.pitStopTimes.length > 0
    ? Math.round((accum.pitStopTimes.reduce((a, b) => a + b, 0) / accum.pitStopTimes.length) * 100) / 100
    : undefined;

  const update: Record<string, any> = {
    assetSlug: accum.assetSlug,
    assetType: accum.assetType,
    season: accum.season,
    racesCompleted: accum.racesCompleted,
    wins: accum.wins,
    podiums: accum.podiums,
    pointsFinishes: accum.pointsFinishes,
    dnfCount: accum.dnfCount,
    totalPoints: Math.round(accum.totalPoints * 100) / 100,
    avgPointsPerRace,
    q3Count: accum.q3Count,
    qualifyingRaces: accum.qualifyingRaces,
    avgQualifyingPosition,
  };
  if (accum.team) update.team = accum.team;
  if (avgPitStopTime !== undefined) update.avgPitStopTime = avgPitStopTime;
  if (accum.fastestStopCount > 0) update.fastestStopCount = accum.fastestStopCount;

  await HistoricalSeason.findOneAndUpdate(
    { assetSlug: accum.assetSlug, season: accum.season },
    { $set: update },
    { upsert: true },
  );
}

function makeAccum(assetSlug: string, assetType: string, season: number, team?: string): SeasonAccum {
  return {
    assetSlug, assetType, season, team,
    racesCompleted: 0, wins: 0, podiums: 0, pointsFinishes: 0,
    dnfCount: 0, totalPoints: 0, q3Count: 0, qualifyingRaces: 0,
    qualifyingPositions: [], pitStopTimes: [], fastestStopCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Main seed logic
// ---------------------------------------------------------------------------

async function seedSeason(season: number, driverAssets: any[], allAssetSlugs: Set<string>, nameSlugMap: Map<string, string>) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Seeding season ${season}`);
  console.log(`${'='.repeat(60)}`);

  const meetings = await getMeetings(season);
  console.log(`  Found ${meetings.length} race weekends`);

  // Season accumulators keyed by slug
  const driverAccums = new Map<string, SeasonAccum>();
  const principalAccums = new Map<string, SeasonAccum>();
  const pitCrewAccums = new Map<string, SeasonAccum>();
  const puAccums = new Map<string, SeasonAccum>();

  for (let roundIdx = 0; roundIdx < meetings.length; roundIdx++) {
    const meeting = meetings[roundIdx];
    const round = roundIdx + 1;
    const shortName = meeting.meeting_name.replace(/Grand Prix/i, 'GP').trim();
    console.log(`\n  [${season}] Round ${round}: ${shortName}`);

    // Get race session
    const raceSess = await getSessionForMeeting(meeting.meeting_key, 'Race');
    if (!raceSess) { console.log(`    Skipping — no Race session found`); continue; }

    const qualSess = await getSessionForMeeting(meeting.meeting_key, 'Qualifying');

    // Fetch all data for this round
    console.log(`    Fetching race results…`);
    let raceResults: Awaited<ReturnType<typeof fetchRaceResults>> = [];
    try { raceResults = await fetchRaceResults(raceSess.session_key); } catch (e: any) { console.warn(`    Race results error: ${e.message}`); }

    console.log(`    Fetching pit data…`);
    let pitData: Awaited<ReturnType<typeof fetchPitData>> = [];
    try { pitData = await fetchPitData(raceSess.session_key); } catch (e: any) { console.warn(`    Pit data error: ${e.message}`); }

    console.log(`    Fetching grid positions…`);
    let gridPositions: Awaited<ReturnType<typeof fetchGridPositions>> = [];
    try { gridPositions = await fetchGridPositions(raceSess.session_key); } catch (e: any) { console.warn(`    Grid positions error: ${e.message}`); }

    let qualResults: Awaited<ReturnType<typeof fetchQualifyingResults>> = [];
    if (qualSess) {
      console.log(`    Fetching qualifying results…`);
      try { qualResults = await fetchQualifyingResults(qualSess.session_key); } catch (e: any) { console.warn(`    Qual results error: ${e.message}`); }
    }

    // Fetch driver info for this session (car number → name/team)
    console.log(`    Fetching driver list…`);
    let drivers: OF1Driver[] = [];
    try { drivers = await fetchDriversForSession(raceSess.session_key); } catch (e: any) { console.warn(`    Drivers error: ${e.message}`); }

    if (drivers.length === 0 || raceResults.length === 0) {
      console.log(`    No data, skipping round`);
      continue;
    }

    // Build maps for this round
    const driverMap = new Map<number, OF1Driver>(); // carNumber → driver info
    for (const d of drivers) driverMap.set(d.driver_number, d);

    const raceByNum = new Map<number, { position: number; dnf: boolean }>();
    for (const r of raceResults) raceByNum.set(r.driverNumber, r);

    const qualByNum = new Map<number, { position: number; qualifyingRound: 'Q1' | 'Q2' | 'Q3' }>();
    for (const q of qualResults) qualByNum.set(q.driverNumber, q);

    const gridByNum = new Map<number, number>();
    for (const g of gridPositions) gridByNum.set(g.driverNumber, g.gridPosition);

    const pitByNum = new Map<number, { stopTimes: number[]; fastestStopOverall: boolean }>();
    for (const p of pitData) pitByNum.set(p.driverNumber, p);

    // Group cars by team for principal/PU calculations
    const teamCars = new Map<string, number[]>(); // teamSlugKey → [carNumbers]
    const teamSlugMap = new Map<string, { principal: string; pitCrew: string; powerUnit: string }>();
    for (const d of drivers) {
      const slugs = resolveTeamSlugs(d.team_name);
      if (!slugs) continue;
      const key = slugs.principal;
      teamSlugMap.set(key, slugs);
      const cars = teamCars.get(key) ?? [];
      cars.push(d.driver_number);
      teamCars.set(key, cars);
    }

    // Pit crew ranking: rank all pit crews by fastest stop this race
    // Build: carNumber → fastest stop time
    const carFastestStop = new Map<number, number>();
    const carAvgStop = new Map<number, number>();
    for (const [carNum, pd] of pitByNum.entries()) {
      if (pd.stopTimes.length === 0) continue;
      carFastestStop.set(carNum, Math.min(...pd.stopTimes));
      carAvgStop.set(carNum, pd.stopTimes.reduce((a, b) => a + b, 0) / pd.stopTimes.length);
    }

    // Rank by fastest single stop
    const fastestStopRanking = Array.from(carFastestStop.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([carNum], idx) => ({ carNum, rank: idx + 1 }));
    const fastestStopRankMap = new Map(fastestStopRanking.map(x => [x.carNum, x.rank]));

    // Rank by avg stop time
    const avgStopRanking = Array.from(carAvgStop.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([carNum], idx) => ({ carNum, rank: idx + 1 }));
    const avgStopRankMap = new Map(avgStopRanking.map(x => [x.carNum, x.rank]));

    // --------------------------------------------------------------------------
    // Process drivers
    // --------------------------------------------------------------------------
    const processedDrivers: Array<{ carNum: number; slug: string; finishPos: number; dnf: boolean; teamName: string }> = [];

    for (const [carNum, driver] of driverMap.entries()) {
      const slug = resolveDriverSlug(driver.full_name, nameSlugMap);
      if (!slug) continue; // driver not in our 2026 assets

      const race = raceByNum.get(carNum);
      if (!race) continue;

      const qual = qualByNum.get(carNum);
      const grid = gridByNum.get(carNum) ?? race.position;

      // Find teammate (same team, different car)
      const teamDrivers = drivers.filter(d => d.team_name === driver.team_name && d.driver_number !== carNum);
      const teammateCarNum = teamDrivers[0]?.driver_number;
      const teammateFinish = teammateCarNum ? (raceByNum.get(teammateCarNum)?.position ?? 22) : 22;
      const teammateQualPos = teammateCarNum ? (qualByNum.get(teammateCarNum)?.position ?? 20) : 20;

      const finishPos = race.dnf ? 22 : race.position;
      const startPos = grid;

      const raceScore = calculateDriverRaceScore({
        finishPosition: finishPos,
        startPosition: startPos,
        teammateFinishPosition: teammateFinish,
        fastestLap: false, // OpenF1 doesn't expose this easily; skip
        notClassified: race.dnf,
        dsq: false,
        startedInTop10: startPos <= 10,
      });

      const qualScore = qual ? calculateDriverQualifyingScore({
        qualifyingPosition: qual.position,
        qualifyingRound: qual.qualifyingRound,
        beatenTeammate: qual.position < teammateQualPos,
        didNotQualify: false,
        dsqFromQualifying: false,
      }) : 0;

      const totalScore = raceScore + qualScore;

      // Update driver accumulator
      if (!driverAccums.has(slug)) {
        driverAccums.set(slug, makeAccum(slug, 'driver', season, driver.team_name));
      }
      const accum = driverAccums.get(slug)!;
      accum.racesCompleted++;
      if (!race.dnf) {
        if (race.position === 1) accum.wins++;
        if (race.position <= 3) accum.podiums++;
        if (race.position <= 10) accum.pointsFinishes++;
      } else {
        accum.dnfCount++;
      }
      accum.totalPoints += totalScore;
      if (qual) {
        accum.qualifyingRaces++;
        accum.qualifyingPositions.push(qual.position);
        if (qual.qualifyingRound === 'Q3') accum.q3Count++;
      }
      if (!accum.team) accum.team = driver.team_name;

      // Upsert race breakdown
      await upsertBreakdown({
        assetSlug: slug,
        assetType: 'driver',
        season,
        round,
        shortName,
        qPos: qual?.position,
        qStage: qual?.qualifyingRound,
        qPts: qual ? qualScore : undefined,
        rPts: raceScore,
        tot: totalScore,
        dnf: race.dnf,
      });

      processedDrivers.push({ carNum, slug, finishPos, dnf: race.dnf, teamName: driver.team_name });
    }

    // --------------------------------------------------------------------------
    // Process pit crews (per car)
    // --------------------------------------------------------------------------
    for (const [carNum, pd] of pitByNum.entries()) {
      const driver = driverMap.get(carNum);
      if (!driver) continue;

      const pitSlug = pitCrewSlugForCar(driver.team_name, carNum);
      if (!pitSlug) continue;

      const fastestRank = fastestStopRankMap.get(carNum) ?? 0;
      const avgRank = avgStopRankMap.get(carNum) ?? 0;
      const pitScore = calculatePitCrewScore(fastestRank, avgRank);

      const sorted = [...pd.stopTimes].sort((a, b) => a - b);
      const avgStop = pd.stopTimes.length > 0
        ? Math.round((pd.stopTimes.reduce((a, b) => a + b, 0) / pd.stopTimes.length) * 100) / 100
        : undefined;

      if (!pitCrewAccums.has(pitSlug)) {
        pitCrewAccums.set(pitSlug, makeAccum(pitSlug, 'pitCrew', season, driver.team_name));
      }
      const accum = pitCrewAccums.get(pitSlug)!;
      accum.racesCompleted++;
      accum.totalPoints += pitScore;
      if (pd.stopTimes.length > 0) accum.pitStopTimes.push(...pd.stopTimes);
      if (pd.fastestStopOverall) accum.fastestStopCount++;

      await upsertBreakdown({
        assetSlug: pitSlug,
        assetType: 'pitCrew',
        season,
        round,
        shortName,
        rPts: pitScore,
        tot: pitScore,
        stopCount: pd.stopTimes.length,
        avgStopTime: avgStop,
        fastestStop: sorted[0] ?? null,
        wasOverallFastest: pd.fastestStopOverall,
        stop1Time: sorted[0] ?? null,
        stop2Time: sorted[1] ?? null,
        stop3Time: sorted[2] ?? null,
      });
    }

    // --------------------------------------------------------------------------
    // Process principals + power units (per team)
    // --------------------------------------------------------------------------
    for (const [principalSlug, carNums] of teamCars.entries()) {
      const slugs = teamSlugMap.get(principalSlug)!;

      // Finish positions for this team's cars
      const teamFinishes = carNums.map(cn => {
        const r = raceByNum.get(cn);
        return r ? (r.dnf ? 22 : r.position) : 22;
      });

      if (teamFinishes.length < 2) continue;

      const d1Pos = teamFinishes[0];
      const d2Pos = teamFinishes[1];

      const d1Driver = driverMap.get(carNums[0]);
      const d2Driver = driverMap.get(carNums[1]);

      // Principal
      const principalScore = calculatePrincipalScore(d1Pos, d2Pos);

      if (!principalAccums.has(principalSlug)) {
        principalAccums.set(principalSlug, makeAccum(principalSlug, 'principal', season));
      }
      const pAccum = principalAccums.get(principalSlug)!;
      pAccum.racesCompleted++;
      pAccum.totalPoints += principalScore;
      if (d1Pos === 1 || d2Pos === 1) pAccum.wins++;
      if (d1Pos <= 3 || d2Pos <= 3) pAccum.podiums++;

      await upsertBreakdown({
        assetSlug: principalSlug,
        assetType: 'principal',
        season,
        round,
        shortName,
        rPts: principalScore,
        tot: principalScore,
        driver1Pos: d1Pos,
        driver2Pos: d2Pos,
        driver1Name: d1Driver?.full_name,
        driver2Name: d2Driver?.full_name,
        dnf: d1Pos === 22 && d2Pos === 22,
      });

      // Power unit
      const puSlug = slugs.powerUnit;
      // Collect ALL cars using this PU this round
      if (!puAccums.has(puSlug)) {
        puAccums.set(puSlug, makeAccum(puSlug, 'powerUnit', season));
      }
    }

    // PU: collect all teams using same PU slug and aggregate their finish positions
    const puFinishes = new Map<string, number[]>();
    const puCarPositions = new Map<string, number[]>();
    for (const [principalSlug, carNums] of teamCars.entries()) {
      const slugs = teamSlugMap.get(principalSlug)!;
      const puSlug = slugs.powerUnit;
      const existing = puFinishes.get(puSlug) ?? [];
      for (const cn of carNums) {
        const r = raceByNum.get(cn);
        existing.push(r ? (r.dnf ? 22 : r.position) : 22);
      }
      puFinishes.set(puSlug, existing);
      puCarPositions.set(puSlug, existing);
    }

    for (const [puSlug, finishes] of puFinishes.entries()) {
      const puScore = calculatePowerUnitScore(finishes);

      if (!puAccums.has(puSlug)) {
        puAccums.set(puSlug, makeAccum(puSlug, 'powerUnit', season));
      }
      const accum = puAccums.get(puSlug)!;
      accum.racesCompleted++;
      accum.totalPoints += puScore;

      await upsertBreakdown({
        assetSlug: puSlug,
        assetType: 'powerUnit',
        season,
        round,
        shortName,
        rPts: puScore,
        tot: puScore,
        carPositions: finishes,
      });
    }

    const driverCount = processedDrivers.length;
    const pitCount = pitByNum.size;
    console.log(`    ✓ drivers: ${driverCount}, pit crews: ${pitCount}, principals: ${teamCars.size}, PUs: ${puFinishes.size}`);
  }

  // --------------------------------------------------------------------------
  // Flush season totals
  // --------------------------------------------------------------------------
  console.log(`\n  Flushing season totals for ${season}…`);
  for (const accum of driverAccums.values()) await flushSeasonAccum(accum);
  for (const accum of principalAccums.values()) await flushSeasonAccum(accum);
  for (const accum of pitCrewAccums.values()) await flushSeasonAccum(accum);
  for (const accum of puAccums.values()) await flushSeasonAccum(accum);

  console.log(`  ✓ Season ${season} complete:`);
  console.log(`    drivers: ${driverAccums.size}, principals: ${principalAccums.size}, pit crews: ${pitCrewAccums.size}, PUs: ${puAccums.size}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  await connectDB();
  console.log('Connected to MongoDB');

  // Load all 2026 driver assets to build name→slug map
  const driverAssets = await Asset.find({ season: 2026, assetType: 'driver' })
    .select('slug name')
    .lean() as Array<{ slug: string; name: string }>;

  console.log(`Loaded ${driverAssets.length} driver assets from 2026`);

  const nameSlugMap = buildNameSlugMap(driverAssets);

  // Load all asset slugs so we can skip unknown slugs gracefully
  const allAssets = await Asset.find({ season: 2026 }).select('slug').lean() as Array<{ slug: string }>;
  const allAssetSlugs = new Set(allAssets.map(a => a.slug as string));

  for (const season of SEASONS) {
    await seedSeason(season, driverAssets, allAssetSlugs, nameSlugMap);
  }

  console.log('\nAll done. Closing connection.');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
