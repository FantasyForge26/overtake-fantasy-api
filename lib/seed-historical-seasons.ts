import 'dotenv/config';
import { connectDB } from './db';
import { HistoricalSeason, HistoricalRaceBreakdown } from './models';
import { getRaceResults, getQualifyingResults, getPitStopData } from './openf1';
import { FINISH_POINTS } from './otf-calculator';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const BASE   = 'https://api.openf1.org/v1';

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
// Car number → driver slug mappings (year-specific, using real car numbers)
// ---------------------------------------------------------------------------

const CAR_TO_SLUG_2024: Record<number, string> = {
  1:  'max-verstappen',   // champion's number
  4:  'lando-norris',
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

// Perez and Bottas not on 2025 grid; Antonelli joins at #12
const CAR_TO_SLUG_2025: Record<number, string> = {
  1:  'max-verstappen',
  4:  'lando-norris',
  10: 'pierre-gasly',
  12: 'kimi-antonelli',
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
  'kimi-antonelli':  'Mercedes',
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

interface RaceRow {
  round:     number;
  flag:      string;
  shortName: string;
  qPos:      number | null;
  qStage:    'Q1' | 'Q2' | 'Q3' | null;
  rPts:      number;
  btBonus:   number;
  pgScore:   number;
  tot:       number;
  dnf:       boolean;
}

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
  fantasyPoints:    number;
  raceRows:         RaceRow[];
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
      fantasyPoints:    0,
      raceRows:         [],
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

    const country   = meeting.country_name ?? meeting.location ?? `R${round}`;
    const flag      = COUNTRY_FLAGS[country] ?? '🏁';
    const shortName = country;

    const qualByNum = new Map(qualResults.map(r => [r.driverNumber, r]));
    const pitByNum  = new Map(pitData.map(p => [p.driverNumber, p]));

    // Build finish and start position maps (needed for BT bonus and positions gained)
    const finishBySlug = new Map<string, number>();
    for (const result of raceResults) {
      const slug = carToSlug[result.driverNumber];
      if (slug && !result.dnf) finishBySlug.set(slug, result.position);
    }
    const startBySlug = new Map<string, number>();
    for (const qual of qualResults) {
      const slug = carToSlug[qual.driverNumber];
      if (slug) startBySlug.set(slug, qual.position);
    }

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

      // Fantasy scoring
      const qPos   = qual?.position ?? null;
      const qStage = qual?.qualifyingRound ?? null;

      if (result.dnf) {
        driver.raceRows.push({ round, flag, shortName, qPos, qStage, rPts: 0, btBonus: 0, pgScore: 0, tot: 0, dnf: true });
      } else {
        const finishPos = result.position;
        const startPos  = startBySlug.get(slug) ?? null;

        const teammateFinish = (() => {
          for (const [otherSlug, otherFinish] of finishBySlug) {
            if (otherSlug !== slug && teamBySlug[otherSlug] === teamBySlug[slug]) return otherFinish;
          }
          return null;
        })();

        const rPts    = (FINISH_POINTS[finishPos] ?? 0) + 1;
        const btBonus = (teammateFinish != null && finishPos < teammateFinish) ? 3 : 0;

        let pgScore = 0;
        if (startPos != null) {
          const delta = startPos - finishPos;
          if (delta > 0) {
            pgScore = Math.min(delta * 2, 10);
          } else if (delta < 0) {
            const lost = -delta;
            pgScore = startPos <= 10 ? -Math.min(lost * 2, 10) : -Math.min(lost, 5);
          }
        }

        const tot = rPts + btBonus + pgScore;
        driver.fantasyPoints += tot;
        driver.raceRows.push({ round, flag, shortName, qPos, qStage, rPts, btBonus, pgScore, tot, dnf: false });
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

    const totalPoints     = Math.round(driver.fantasyPoints * 100) / 100;
    const avgPointsPerRace = driver.racesCompleted > 0
      ? Math.round((totalPoints / driver.racesCompleted) * 100) / 100
      : 0;

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
        totalPoints,
        avgPointsPerRace,
        q3Count:              driver.q3Count,
        qualifyingRaces:      driver.qualifyingRaces,
        avgQualifyingPosition,
        ...(avgPitStopTime !== undefined && { avgPitStopTime }),
        fastestStopCount:     driver.fastestStopCount,
      },
      { upsert: true, new: true },
    );

    // Save per-race breakdown documents
    for (const row of driver.raceRows) {
      await HistoricalRaceBreakdown.findOneAndUpdate(
        { assetSlug: driver.slug, season: year, round: row.round },
        {
          assetSlug: driver.slug,
          season:    year,
          round:     row.round,
          flag:      row.flag,
          shortName: row.shortName,
          qPos:      row.qPos,
          qStage:    row.qStage,
          qPts:      null,
          rPts:      row.rPts,
          flBonus:   0,
          btBonus:   row.btBonus,
          pgScore:   row.pgScore,
          tot:       row.tot,
          dnf:       row.dnf,
        },
        { upsert: true, new: true },
      );
    }

    console.log(
      `  ✓ ${driver.slug} (${year}): ` +
      `${driver.racesCompleted} races, ${driver.wins}W ${driver.podiums}P, ` +
      `q3=${driver.q3Count}, dnf=${driver.dnfCount}, pts=${totalPoints}`,
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

  console.log('Deleting existing HistoricalRaceBreakdown documents…');
  const { deletedCount: brkDeleted } = await HistoricalRaceBreakdown.deleteMany({});
  console.log(`  ✓ deleted ${brkDeleted} documents`);

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
