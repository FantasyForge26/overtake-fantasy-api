import 'dotenv/config';
import { connectDB } from './db';
import { HistoricalSeason } from './models';
import { getRaceResults, getQualifyingResults, getPitStopData } from './openf1';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const BASE   = 'https://api.openf1.org/v1';

// ---------------------------------------------------------------------------
// Local raw fetcher — used only for meetings and session-key lookups.
// The imported openf1 functions handle their own internal rate-limit sleeps.
// ---------------------------------------------------------------------------

async function rawFetch<T>(path: string): Promise<T[]> {
  await sleep(2000);
  return fetchWithRetry<T>(path);
}

async function fetchWithRetry<T>(path: string, attemptsLeft = 5): Promise<T[]> {
  const res = await fetch(`${BASE}${path}`);
  if (res.status === 429) {
    if (attemptsLeft <= 1) throw new Error(`OpenF1 429 after max retries: ${path}`);
    console.warn(`  429 received, waiting 5 s… (${attemptsLeft - 1} retries left)`);
    await sleep(5000);
    return fetchWithRetry<T>(path, attemptsLeft - 1);
  }
  if (!res.ok) throw new Error(`OpenF1 ${res.status}: ${path}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Car number → driver slug mappings
//
// NOTE: These numbers reflect the 2026 fantasy grid numbering. Some differ
// from real 2024/2025 car numbers (e.g. in reality #1 was Max Verstappen
// in 2024, #4 was Lando Norris). Update if you want real historical accuracy.
// ---------------------------------------------------------------------------

const CAR_TO_SLUG_2024: Record<number, string> = {
  1:  'lando-norris',
  3:  'max-verstappen',
  10: 'pierre-gasly',
  11: 'sergio-perez',
  14: 'fernando-alonso',
  16: 'charles-leclerc',
  18: 'lance-stroll',
  23: 'alex-albon',
  27: 'nico-hulkenberg',
  31: 'esteban-ocon',
  44: 'lewis-hamilton',
  55: 'carlos-sainz',
  63: 'george-russell',
  77: 'valtteri-bottas',
  81: 'oscar-piastri',
};

// Perez (#11) retired after 2024; Bottas (#77) not retained for 2025
const CAR_TO_SLUG_2025: Record<number, string> = {
  1:  'lando-norris',
  3:  'max-verstappen',
  10: 'pierre-gasly',
  14: 'fernando-alonso',
  16: 'charles-leclerc',
  18: 'lance-stroll',
  23: 'alex-albon',
  27: 'nico-hulkenberg',
  31: 'esteban-ocon',
  44: 'lewis-hamilton',
  55: 'carlos-sainz',
  63: 'george-russell',
  81: 'oscar-piastri',
};

// ---------------------------------------------------------------------------
// Team names per driver per year (for the team field in HistoricalSeason)
// ---------------------------------------------------------------------------

const TEAMS_2024: Record<string, string> = {
  'lando-norris':    'McLaren',
  'max-verstappen':  'Red Bull',
  'pierre-gasly':    'Alpine',
  'sergio-perez':    'Red Bull',
  'fernando-alonso': 'Aston Martin',
  'charles-leclerc': 'Ferrari',
  'lance-stroll':    'Aston Martin',
  'alex-albon':      'Williams',
  'nico-hulkenberg': 'Haas',
  'esteban-ocon':    'Alpine',
  'lewis-hamilton':  'Mercedes',
  'carlos-sainz':    'Ferrari',
  'george-russell':  'Mercedes',
  'valtteri-bottas': 'Sauber',
  'oscar-piastri':   'McLaren',
};

const TEAMS_2025: Record<string, string> = {
  'lando-norris':    'McLaren',
  'max-verstappen':  'Red Bull',
  'pierre-gasly':    'Alpine',
  'fernando-alonso': 'Aston Martin',
  'charles-leclerc': 'Ferrari',
  'lance-stroll':    'Aston Martin',
  'alex-albon':      'Williams',
  'nico-hulkenberg': 'Sauber',
  'esteban-ocon':    'Haas',
  'lewis-hamilton':  'Ferrari',
  'carlos-sainz':    'Williams',
  'george-russell':  'Mercedes',
  'oscar-piastri':   'McLaren',
};

// ---------------------------------------------------------------------------
// Per-driver accumulator
// ---------------------------------------------------------------------------

interface DriverAcc {
  slug:             string;
  team:             string;
  racesCompleted:   number;
  wins:             number;
  podiums:          number;
  pointsFinishes:   number;
  dnfCount:         number;
  q3Count:          number;
  qualifyingRaces:  number;
  qualPositions:    number[];
  pitStopTimes:     number[];
  fastestStopCount: number;
}

// ---------------------------------------------------------------------------
// Seed one year
// ---------------------------------------------------------------------------

async function seedYear(year: number): Promise<void> {
  const carToSlug  = year === 2024 ? CAR_TO_SLUG_2024  : CAR_TO_SLUG_2025;
  const teamBySlug = year === 2024 ? TEAMS_2024        : TEAMS_2025;

  // Initialise accumulator for every tracked driver
  const acc = new Map<string, DriverAcc>();
  for (const slug of Object.values(carToSlug)) {
    acc.set(slug, {
      slug,
      team:             teamBySlug[slug] ?? '',
      racesCompleted:   0,
      wins:             0,
      podiums:          0,
      pointsFinishes:   0,
      dnfCount:         0,
      q3Count:          0,
      qualifyingRaces:  0,
      qualPositions:    [],
      pitStopTimes:     [],
      fastestStopCount: 0,
    });
  }

  // Fetch all meetings
  console.log(`\n── ${year} ──────────────────────────────────────`);
  console.log('Fetching meetings…');
  const allMeetings = await rawFetch<any>(`/meetings?year=${year}`);
  const meetings = allMeetings
    .filter(m => !/test/i.test(m.meeting_name))
    .sort((a, b) => new Date(a.date_start).getTime() - new Date(b.date_start).getTime());

  console.log(`Found ${meetings.length} race meetings`);

  for (let i = 0; i < meetings.length; i++) {
    const meeting = meetings[i];
    const round   = i + 1;

    // Race session key
    await sleep(2000);
    const raceSessions = await rawFetch<any>(
      `/sessions?meeting_key=${meeting.meeting_key}&session_type=Race`,
    );
    if (!raceSessions.length) {
      console.log(`  ${year} Round ${round}: no Race session — skipping`);
      continue;
    }
    const raceSessionKey = raceSessions[0].session_key;

    // Qualifying session key (may not exist for all rounds)
    await sleep(2000);
    const qualSessions = await rawFetch<any>(
      `/sessions?meeting_key=${meeting.meeting_key}&session_type=Qualifying`,
    );
    const qualSessionKey: number | null = qualSessions[0]?.session_key ?? null;

    // Fetch data from OpenF1 (each function has internal 500 ms sleeps)
    let raceResults: Awaited<ReturnType<typeof getRaceResults>> = [];
    try {
      raceResults = await getRaceResults(raceSessionKey);
    } catch (err: any) {
      console.warn(`  ⚠ race results unavailable for round ${round}: ${err.message}`);
    }

    let qualResults: Awaited<ReturnType<typeof getQualifyingResults>> = [];
    try {
      qualResults = qualSessionKey ? await getQualifyingResults(qualSessionKey) : [];
    } catch (err: any) {
      console.warn(`  ⚠ qualifying results unavailable for round ${round}: ${err.message}`);
    }

    let pitData: Awaited<ReturnType<typeof getPitStopData>> = [];
    try {
      pitData = await getPitStopData(raceSessionKey);
    } catch (err: any) {
      console.warn(`  ⚠ pit stop data unavailable for round ${round}: ${err.message}`);
    }

    const qualByNum = new Map(qualResults.map(r => [r.driverNumber, r]));
    const pitByNum  = new Map(pitData.map(p => [p.driverNumber, p]));

    let processed = 0;

    for (const result of raceResults) {
      const slug   = carToSlug[result.driverNumber];
      const driver = slug ? acc.get(slug) : undefined;
      if (!driver) continue;

      // Race stats — DNF still counts as a race started
      driver.racesCompleted++;
      if (result.dnf) {
        driver.dnfCount++;
      } else {
        if (result.position === 1)  driver.wins++;
        if (result.position <= 3)   driver.podiums++;
        if (result.position <= 10)  driver.pointsFinishes++;
      }

      // Qualifying stats
      const qual = qualByNum.get(result.driverNumber);
      if (qual) {
        driver.qualifyingRaces++;
        driver.qualPositions.push(qual.position);
        if (qual.qualifyingRound === 'Q3') driver.q3Count++;
      }

      // Pit stop stats
      const pit = pitByNum.get(result.driverNumber);
      if (pit?.stopTimes.length) {
        driver.pitStopTimes.push(...pit.stopTimes);
        if (pit.fastestStopOverall) driver.fastestStopCount++;
      }

      processed++;
    }

    console.log(`  ✓ ${year} Round ${round}: processed ${processed} drivers`);
    await sleep(2000);
  }

  // Save HistoricalSeason documents
  console.log(`\nSaving ${year} HistoricalSeason documents…`);
  for (const driver of acc.values()) {
    const avgQualifyingPosition = driver.qualPositions.length
      ? Math.round((driver.qualPositions.reduce((a, b) => a + b, 0) / driver.qualPositions.length) * 100) / 100
      : 0;
    const avgPitStopTime = driver.pitStopTimes.length
      ? Math.round((driver.pitStopTimes.reduce((a, b) => a + b, 0) / driver.pitStopTimes.length) * 1000) / 1000
      : undefined;

    await HistoricalSeason.findOneAndUpdate(
      { assetSlug: driver.slug, season: year },
      {
        assetSlug:            driver.slug,
        assetType:            'driver',
        season:               year,
        team:                 driver.team,
        racesCompleted:       driver.racesCompleted,
        wins:                 driver.wins,
        podiums:              driver.podiums,
        pointsFinishes:       driver.pointsFinishes,
        dnfCount:             driver.dnfCount,
        totalPoints:          0,   // not calculated here — needs full race scoring
        avgPointsPerRace:     0,
        q3Count:              driver.q3Count,
        qualifyingRaces:      driver.qualifyingRaces,
        avgQualifyingPosition,
        ...(avgPitStopTime !== undefined && { avgPitStopTime }),
        fastestStopCount:     driver.fastestStopCount,
      },
      { upsert: true, new: true },
    );

    console.log(
      `  ✓ ${driver.slug} (${year}): ` +
      `${driver.racesCompleted} races, ${driver.wins}W ${driver.podiums}P, ` +
      `q3=${driver.q3Count}, dnf=${driver.dnfCount}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await connectDB();

  console.log('Deleting existing HistoricalSeason documents…');
  const { deletedCount } = await HistoricalSeason.deleteMany({});
  console.log(`  ✓ deleted ${deletedCount} documents`);

  for (const year of [2024, 2025]) {
    await seedYear(year);
  }

  console.log('\n✅ Done!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
