/**
 * Seed 2025 pit crew historical race breakdown data.
 * - Deletes all existing pitCrew HistoricalRaceBreakdown docs
 * - Fetches raw pit_duration from OpenF1 for every 2025 race (no offset subtraction)
 * - Filters: 15s <= pit_duration <= 60s
 * - Ranks per car (not per team) for fastestRank / avgRank
 * - Saves HistoricalRaceBreakdown + HistoricalSeason per car slug
 */

import mongoose from 'mongoose';
import { HistoricalSeason, HistoricalRaceBreakdown } from './models';
import { calculatePitCrewScore } from './otf-calculator';

const MONGO_URI =
  'mongodb+srv://info_db_user:PhatPhat00!@overtake-fantasy.kv0g64a.mongodb.net/overtake-fantasy?appName=Overtake-Fantasy';

// ---------------------------------------------------------------------------
// 2025 car number → pit crew slug prefix
// ---------------------------------------------------------------------------

const CAR_TO_PIT_SLUG_PREFIX_2025: Record<number, string> = {
  1:  'red-bull-pit-crew',
  30: 'red-bull-pit-crew',
  4:  'mclaren-pit-crew',
  81: 'mclaren-pit-crew',
  16: 'ferrari-pit-crew',
  44: 'ferrari-pit-crew',
  12: 'mercedes-pit-crew',
  63: 'mercedes-pit-crew',
  14: 'aston-martin-pit-crew',
  18: 'aston-martin-pit-crew',
  10: 'alpine-pit-crew',
  7:  'alpine-pit-crew',
  23: 'williams-pit-crew',
  55: 'williams-pit-crew',
  6:  'racing-bulls-pit-crew',
  41: 'racing-bulls-pit-crew',
  31: 'haas-pit-crew',
  87: 'haas-pit-crew',
  27: 'audi-pit-crew',
  5:  'audi-pit-crew',
};

const COUNTRY_FLAGS: Record<string, string> = {
  'Australia': '🇦🇺', 'China': '🇨🇳', 'Japan': '🇯🇵',
  'Bahrain': '🇧🇭', 'Saudi Arabia': '🇸🇦', 'United States': '🇺🇸',
  'Canada': '🇨🇦', 'Monaco': '🇲🇨', 'Spain': '🇪🇸',
  'Austria': '🇦🇹', 'United Kingdom': '🇬🇧', 'Belgium': '🇧🇪',
  'Hungary': '🇭🇺', 'Netherlands': '🇳🇱', 'Italy': '🇮🇹',
  'Azerbaijan': '🇦🇿', 'Singapore': '🇸🇬', 'Mexico': '🇲🇽',
  'Brazil': '🇧🇷', 'Qatar': '🇶🇦', 'Abu Dhabi': '🇦🇪',
};

// ---------------------------------------------------------------------------
// OpenF1 helpers
// ---------------------------------------------------------------------------

const BASE = 'https://api.openf1.org/v1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry<T>(path: string, attemptsLeft = 5): Promise<T[]> {
  const res = await fetch(`${BASE}${path}`);
  if (res.status === 429) {
    if (attemptsLeft <= 1) throw new Error(`429 after max retries: ${path}`);
    console.warn(`  429 received, waiting 15s… (${attemptsLeft - 1} retries left)`);
    await sleep(15000);
    return fetchWithRetry<T>(path, attemptsLeft - 1);
  }
  if (!res.ok) throw new Error(`OpenF1 ${res.status}: ${path}`);
  return res.json();
}

async function rawFetch<T>(path: string): Promise<T[]> {
  await sleep(500);
  return fetchWithRetry<T>(path);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB\n');

  // 1. Delete ALL existing pitCrew HistoricalRaceBreakdown docs
  const deleted = await HistoricalRaceBreakdown.deleteMany({ assetType: 'pitCrew' });
  console.log(`Deleted ${deleted.deletedCount} existing pitCrew HistoricalRaceBreakdown docs\n`);

  // 2. Fetch 2025 race meetings
  console.log('Fetching 2025 race meetings…');
  const allMeetings = await rawFetch<any>('/meetings?year=2025');
  const meetings = allMeetings
    .filter((m: any) => !/test/i.test(m.meeting_name))
    .sort((a: any, b: any) => new Date(a.date_start).getTime() - new Date(b.date_start).getTime());
  console.log(`Found ${meetings.length} race meetings\n`);

  // Per-car season accumulator for HistoricalSeason
  const carAcc: Record<number, { totalPts: number; races: number; allStops: number[]; fastestStopCount: number }> = {};
  for (const carNum of Object.keys(CAR_TO_PIT_SLUG_PREFIX_2025).map(Number)) {
    carAcc[carNum] = { totalPts: 0, races: 0, allStops: [], fastestStopCount: 0 };
  }

  // 3. Process each race
  for (let i = 0; i < meetings.length; i++) {
    const meeting = meetings[i];
    const round = i + 1;
    const country = meeting.country_name ?? meeting.location ?? `R${round}`;
    const flag = COUNTRY_FLAGS[country] ?? '🏁';
    const shortName = country;

    // Race session
    const raceSessions = await rawFetch<any>(
      `/sessions?meeting_key=${meeting.meeting_key}&session_type=Race`,
    );
    if (!raceSessions.length) {
      console.log(`  Round ${round} (${country}): no race session, skipping`);
      continue;
    }
    const sessionKey = raceSessions[0].session_key;

    // Pit stop data — raw pit_duration, no offset
    let pits: any[] = [];
    try {
      pits = await rawFetch<any>(`/pit?session_key=${sessionKey}`);
    } catch (err: any) {
      console.warn(`  Round ${round} (${country}): pit data unavailable — ${err.message}`);
      continue;
    }

    // Group by car number, apply validity filter
    const carStops: Record<number, number[]> = {};
    for (const p of pits) {
      if (p.pit_duration == null) continue;
      if (p.pit_duration < 15 || p.pit_duration > 60) continue;
      const carNum: number = p.driver_number;
      if (!CAR_TO_PIT_SLUG_PREFIX_2025[carNum]) continue;
      const t = Math.round(p.pit_duration * 100) / 100;
      if (!carStops[carNum]) carStops[carNum] = [];
      carStops[carNum].push(t);
    }

    const carsWithData = Object.keys(carStops).map(Number).filter(n => carStops[n].length > 0);
    if (carsWithData.length < 2) {
      console.log(`  Round ${round} (${country}): only ${carsWithData.length} car(s) with valid pit data, skipping`);
      continue;
    }

    // Rank per car by fastest stop and avg stop
    const fastestByCar: Record<number, number> = {};
    const avgByCar: Record<number, number> = {};
    for (const carNum of carsWithData) {
      const stops = carStops[carNum];
      fastestByCar[carNum] = Math.min(...stops);
      avgByCar[carNum] = stops.reduce((a, b) => a + b, 0) / stops.length;
    }

    const fastestRanking = [...carsWithData].sort((a, b) => fastestByCar[a] - fastestByCar[b]);
    const avgRanking     = [...carsWithData].sort((a, b) => avgByCar[a]     - avgByCar[b]);
    const overallFastestCar = fastestRanking[0];

    // Save HistoricalRaceBreakdown per car
    for (const carNum of carsWithData) {
      const slugPrefix = CAR_TO_PIT_SLUG_PREFIX_2025[carNum];
      const assetSlug  = `${slugPrefix}-${carNum}`;
      const stopTimes  = carStops[carNum];

      const fastestRank = fastestRanking.indexOf(carNum) + 1;
      const avgRank     = avgRanking.indexOf(carNum) + 1;
      const rPts        = calculatePitCrewScore(fastestRank, avgRank);

      const stopCount       = stopTimes.length;
      const avgStopTime     = Math.round((stopTimes.reduce((a, b) => a + b, 0) / stopCount) * 100) / 100;
      const fastestStop     = Math.round(Math.min(...stopTimes) * 100) / 100;
      const wasOverallFastest = carNum === overallFastestCar;
      const sorted          = [...stopTimes].sort((a, b) => a - b);

      await HistoricalRaceBreakdown.findOneAndUpdate(
        { assetSlug, season: 2025, round },
        {
          assetSlug,
          assetType: 'pitCrew',
          season: 2025,
          round,
          flag,
          shortName,
          rPts,
          flBonus:  wasOverallFastest ? 1 : 0,
          btBonus:  0,
          pgScore:  0,
          tot:      rPts,
          dnf:      false,
          stopCount,
          avgStopTime,
          fastestStop,
          wasOverallFastest,
          stop1Time: sorted[0] ?? null,
          stop2Time: sorted[1] ?? null,
          stop3Time: sorted[2] ?? null,
        },
        { upsert: true, new: true },
      );

      // Accumulate for HistoricalSeason
      carAcc[carNum].totalPts += rPts;
      carAcc[carNum].races++;
      carAcc[carNum].allStops.push(...stopTimes);
      if (wasOverallFastest) carAcc[carNum].fastestStopCount++;
    }

    console.log(`  ✓ Round ${round} (${country}): ${carsWithData.length} cars, fastest=${fastestByCar[overallFastestCar].toFixed(2)}s (car #${overallFastestCar})`);
  }

  // 4. Save HistoricalSeason per car slug
  console.log('\nSaving HistoricalSeason docs…');
  for (const [carNumStr, data] of Object.entries(carAcc)) {
    const carNum    = Number(carNumStr);
    const slugPrefix = CAR_TO_PIT_SLUG_PREFIX_2025[carNum];
    if (!slugPrefix || data.races === 0) continue;

    const assetSlug      = `${slugPrefix}-${carNum}`;
    const totalPoints    = Math.round(data.totalPts * 100) / 100;
    const avgPointsPerRace = Math.round((data.totalPts / data.races) * 100) / 100;
    const avgPitStopTime = data.allStops.length > 0
      ? Math.round((data.allStops.reduce((a, b) => a + b, 0) / data.allStops.length) * 100) / 100
      : undefined;

    await HistoricalSeason.findOneAndUpdate(
      { assetSlug, season: 2025 },
      {
        assetSlug,
        assetType:        'pitCrew',
        season:           2025,
        racesCompleted:   data.races,
        totalPoints,
        avgPointsPerRace,
        fastestStopCount: data.fastestStopCount,
        ...(avgPitStopTime !== undefined && { avgPitStopTime }),
      },
      { upsert: true, new: true },
    );
    console.log(`  ✓ ${assetSlug}: ${data.races} races, pts=${totalPoints.toFixed(2)}, avgStop=${avgPitStopTime?.toFixed(2)}s`);
  }

  console.log('\n✅ 2025 pit crew seed complete');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
