import 'dotenv/config';
import { connectDB } from './db';
import { HistoricalSeason, HistoricalRaceBreakdown } from './models';
import { getRaceResults, getPitStopData } from './openf1';
import { calculatePitCrewScore, calculatePowerUnitScore, calculatePrincipalScore } from './otf-calculator';

const COUNTRY_FLAGS: Record<string, string> = {
  'Australia': '🇦🇺', 'China': '🇨🇳', 'Japan': '🇯🇵',
  'Bahrain': '🇧🇭', 'Saudi Arabia': '🇸🇦', 'United States': '🇺🇸',
  'Canada': '🇨🇦', 'Monaco': '🇲🇨', 'Spain': '🇪🇸',
  'Austria': '🇦🇹', 'United Kingdom': '🇬🇧', 'Belgium': '🇧🇪',
  'Hungary': '🇭🇺', 'Netherlands': '🇳🇱', 'Italy': '🇮🇹',
  'Azerbaijan': '🇦🇿', 'Singapore': '🇸🇬', 'Mexico': '🇲🇽',
  'Brazil': '🇧🇷', 'Qatar': '🇶🇦', 'Abu Dhabi': '🇦🇪',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const BASE = 'https://api.openf1.org/v1';

async function fetchWithRetry<T>(path: string, attemptsLeft = 5): Promise<T[]> {
  const res = await fetch(`${BASE}${path}`);
  if (res.status === 429) {
    if (attemptsLeft <= 1) throw new Error(`OpenF1 429 after max retries: ${path}`);
    console.warn(`  429 received, waiting 5 s… (${attemptsLeft - 1} retries left)`);
    await sleep(15000);
    return fetchWithRetry<T>(path, attemptsLeft - 1);
  }
  if (!res.ok) throw new Error(`OpenF1 ${res.status}: ${path}`);
  return res.json();
}

async function rawFetch<T>(path: string): Promise<T[]> {
  await sleep(2000);
  return fetchWithRetry<T>(path);
}

// ---------------------------------------------------------------------------
// Grid mappings: car number → team name (year-specific)
// ---------------------------------------------------------------------------

const CAR_TO_TEAM_2024: Record<number, string> = {
  1:  'Red Bull',
  11: 'Red Bull',
  4:  'McLaren',
  81: 'McLaren',
  16: 'Ferrari',
  55: 'Ferrari',
  44: 'Mercedes',
  63: 'Mercedes',
  14: 'Aston Martin',
  18: 'Aston Martin',
  10: 'Alpine',
  31: 'Alpine',
  23: 'Williams',
  2:  'Williams',        // Sargeant (retired mid-season, Colapinto replaced)
  22: 'Racing Bulls',   // Tsunoda
  3:  'Racing Bulls',   // Ricciardo
  27: 'Haas',
  20: 'Haas',           // Magnussen
  77: 'Sauber',
  24: 'Sauber',         // Zhou
};

const CAR_TO_TEAM_2025: Record<number, string> = {
  1:  'Red Bull',
  30: 'Red Bull',       // Lawson
  4:  'McLaren',
  81: 'McLaren',
  16: 'Ferrari',
  44: 'Ferrari',
  12: 'Mercedes',
  63: 'Mercedes',
  14: 'Aston Martin',
  18: 'Aston Martin',
  10: 'Alpine',
  7:  'Alpine',         // Doohan
  23: 'Williams',
  55: 'Williams',
  6:  'Racing Bulls',   // Hadjar
  41: 'Racing Bulls',   // Colapinto
  31: 'Haas',
  87: 'Haas',           // Bearman
  27: 'Audi',           // Hulkenberg (team rebranded from Sauber)
  5:  'Audi',           // Bortoleto
};

// ---------------------------------------------------------------------------
// Principal slug → team name
// ---------------------------------------------------------------------------

const PRINCIPAL_TO_TEAM: Record<string, string> = {
  'christian-horner':   'Red Bull',
  'zak-brown':          'McLaren',
  'fred-vasseur':       'Ferrari',
  'toto-wolff':         'Mercedes',
  'mike-krack':         'Aston Martin',
  'oliver-oakes':       'Alpine',
  'james-vowles':       'Williams',
  'ayao-komatsu':       'Haas',
  'mattia-binotto':     'Sauber',
};

// ---------------------------------------------------------------------------
// Power unit slug → teams that use it
// ---------------------------------------------------------------------------

const PU_TO_TEAMS_2024: Record<string, string[]> = {
  'honda-rbpt-pu':    ['Red Bull'],
  'mercedes-pu':      ['Mercedes', 'Aston Martin', 'Williams'],
  'ferrari-pu':       ['Ferrari', 'Haas', 'Sauber'],
  'renault-pu':       ['Alpine'],
};

const PU_TO_TEAMS_2025: Record<string, string[]> = {
  'honda-rbpt-pu':    ['Red Bull', 'Aston Martin'],
  'mercedes-pu':      ['Mercedes', 'Williams'],
  'ferrari-pu':       ['Ferrari', 'Haas', 'Sauber'],
  'renault-pu':       ['Alpine'],
};

// Each team's own PU asset slug (used to fan-out identical manufacturer data
// to every team that ran that PU — e.g. Williams users see williams-pu history)
const TEAM_TO_PU_SLUG: Record<string, string> = {
  'Red Bull':     'red-bull-pu',
  'McLaren':      'mclaren-pu',
  'Ferrari':      'ferrari-pu',
  'Mercedes':     'mercedes-pu',
  'Aston Martin': 'aston-martin-pu',
  'Alpine':       'alpine-pu',
  'Williams':     'williams-pu',
  'Haas':         'haas-pu',
  'Sauber':       'sauber-pu',
  'Racing Bulls': 'racing-bulls-pu',
  'Audi':         'audi-pu',
};

// ---------------------------------------------------------------------------
// Pit crew: team name → [car numbers] per year
// Asset slugs are per-car: e.g. "ferrari-pit-crew-16", "ferrari-pit-crew-44"
// The team-slug prefix maps as: team name → slug prefix
// ---------------------------------------------------------------------------

const TEAM_TO_PIT_SLUG_PREFIX: Record<string, string> = {
  'Red Bull':     'red-bull-pit-crew',
  'McLaren':      'mclaren-pit-crew',
  'Ferrari':      'ferrari-pit-crew',
  'Mercedes':     'mercedes-pit-crew',
  'Aston Martin': 'aston-martin-pit-crew',
  'Alpine':       'alpine-pit-crew',
  'Williams':     'williams-pit-crew',
  'Haas':         'haas-pit-crew',
  'Sauber':       'sauber-pit-crew',
  'Racing Bulls': 'racing-bulls-pit-crew',
  'Audi':         'audi-pit-crew',
};

// Build team → car numbers from the existing CAR_TO_TEAM maps
function buildTeamToCarNums(carToTeam: Record<number, string>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [carStr, team] of Object.entries(carToTeam)) {
    if (!out[team]) out[team] = [];
    out[team].push(Number(carStr));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seed principals for one year
// ---------------------------------------------------------------------------

async function seedPrincipals(
  year: number,
  meetings: any[],
  carToTeam: Record<number, string>,
): Promise<void> {
  console.log(`\n── Principals ${year} ──`);

  type PrincipalRow = {
    round: number; flag: string; shortName: string; rPts: number; tot: number;
    driver1Pos?: number; driver2Pos?: number; driver1Name?: string; driver2Name?: string;
  };
  const acc: Record<string, { team: string; races: number; totalPoints: number; wins: number; rows: PrincipalRow[] }> = {};
  for (const [slug, team] of Object.entries(PRINCIPAL_TO_TEAM)) {
    acc[slug] = { team, races: 0, totalPoints: 0, wins: 0, rows: [] };
  }

  for (let i = 0; i < meetings.length; i++) {
    const meeting = meetings[i];
    const round = i + 1;
    const country = meeting.country_name ?? meeting.location ?? `R${round}`;
    const flag = COUNTRY_FLAGS[country] ?? '🏁';
    const shortName = country;

    await sleep(2000);
    const raceSessions = await rawFetch<any>(
      `/sessions?meeting_key=${meeting.meeting_key}&session_type=Race`,
    );
    if (!raceSessions.length) continue;
    const raceSessionKey = raceSessions[0].session_key;

    let raceResults: any[] = [];
    try {
      await sleep(2000);
      raceResults = await getRaceResults(raceSessionKey);
    } catch (err: any) {
      console.warn(`  ⚠ race results unavailable for round ${round}: ${err.message}`);
      continue;
    }

    // Fetch driver name map: car number → last name
    let carToLastName: Record<number, string> = {};
    try {
      await sleep(2000);
      const driverEntries = await rawFetch<any>(`/drivers?session_key=${raceSessionKey}`);
      for (const d of driverEntries) {
        const num = d.driver_number ?? d.car_number;
        const name = d.last_name ?? d.full_name?.split(' ').pop() ?? `#${num}`;
        if (num != null) carToLastName[num] = name;
      }
    } catch {
      // names are optional — proceed without them
    }

    // Build team → { position, driverNumber }[] for all finishers (including DNFs for name lookup)
    const teamDriverResults: Record<string, { pos: number; num: number; dnf: boolean }[]> = {};
    for (const result of raceResults) {
      const team = carToTeam[result.driverNumber];
      if (!team) continue;
      if (!teamDriverResults[team]) teamDriverResults[team] = [];
      teamDriverResults[team].push({ pos: result.position, num: result.driverNumber, dnf: result.dnf });
    }

    // For scoring, exclude DNFs
    const teamFinishes: Record<string, number[]> = {};
    for (const [team, drivers] of Object.entries(teamDriverResults)) {
      teamFinishes[team] = drivers.filter(d => !d.dnf).map(d => d.pos);
    }

    for (const [, data] of Object.entries(acc)) {
      const positions = teamFinishes[data.team] ?? [];
      if (positions.length === 0) continue;

      data.races++;
      const sorted = [...positions].sort((a, b) => a - b);
      const p1 = sorted[0] ?? 20;
      const p2 = sorted[1] ?? 20;
      const pts = calculatePrincipalScore(p1, p2);
      data.totalPoints += pts;
      if (positions.includes(1)) data.wins++;

      // Driver positions (sorted best first; include DNF entries for display)
      const allDrivers = (teamDriverResults[data.team] ?? [])
        .sort((a, b) => (a.dnf ? 1 : 0) - (b.dnf ? 1 : 0) || a.pos - b.pos);
      const d1 = allDrivers[0];
      const d2 = allDrivers[1];

      data.rows.push({
        round, flag, shortName, rPts: pts, tot: pts,
        driver1Pos:  d1 && !d1.dnf ? d1.pos : undefined,
        driver2Pos:  d2 && !d2.dnf ? d2.pos : undefined,
        driver1Name: d1 ? (carToLastName[d1.num] ?? `#${d1.num}`) : undefined,
        driver2Name: d2 ? (carToLastName[d2.num] ?? `#${d2.num}`) : undefined,
      });
    }

    console.log(`  ✓ Round ${round}: processed ${Object.keys(teamFinishes).length} teams`);
  }

  console.log(`Saving ${year} principal HistoricalSeason + HistoricalRaceBreakdown documents…`);
  for (const [slug, data] of Object.entries(acc)) {
    const avgPointsPerRace = data.races > 0
      ? Math.round((data.totalPoints / data.races) * 100) / 100
      : 0;
    await HistoricalSeason.findOneAndUpdate(
      { assetSlug: slug, season: year },
      {
        assetSlug:       slug,
        assetType:       'principal',
        season:          year,
        team:            data.team,
        racesCompleted:  data.races,
        wins:            data.wins,
        totalPoints:     Math.round(data.totalPoints * 100) / 100,
        avgPointsPerRace,
      },
      { upsert: true, new: true },
    );
    for (const row of data.rows) {
      const updateDoc = {
        assetSlug: slug, season: year, round: row.round,
        flag: row.flag, shortName: row.shortName,
        rPts: row.rPts, btBonus: 0, pgScore: 0, tot: row.tot, dnf: false,
        ...(row.driver1Pos  !== undefined && { driver1Pos:  row.driver1Pos }),
        ...(row.driver2Pos  !== undefined && { driver2Pos:  row.driver2Pos }),
        ...(row.driver1Name !== undefined && { driver1Name: row.driver1Name }),
        ...(row.driver2Name !== undefined && { driver2Name: row.driver2Name }),
      };
      if (row.round === 1) {
        console.log(`  [debug] ${slug} round 1 updateDoc:`, JSON.stringify(updateDoc));
      }
      await HistoricalRaceBreakdown.findOneAndUpdate(
        { assetSlug: slug, season: year, round: row.round },
        updateDoc,
        { upsert: true, new: true },
      );
    }
    console.log(`  ✓ ${slug} (${year}): ${data.races} races, ${data.wins}W, pts=${data.totalPoints.toFixed(1)}`);
  }
}

// ---------------------------------------------------------------------------
// Seed power units for one year
// ---------------------------------------------------------------------------

async function seedPowerUnits(
  year: number,
  meetings: any[],
  carToTeam: Record<number, string>,
  puToTeams: Record<string, string[]>,
): Promise<void> {
  console.log(`\n── Power Units ${year} ──`);

  type PURow = {
    round: number; flag: string; shortName: string; rPts: number; tot: number;
    carPositions: number[];
  };
  // acc keyed by canonical manufacturer slug (e.g. 'mercedes-pu')
  const acc: Record<string, { races: number; totalPoints: number; rows: PURow[] }> = {};
  for (const slug of Object.keys(puToTeams)) {
    acc[slug] = { races: 0, totalPoints: 0, rows: [] };
  }

  for (let i = 0; i < meetings.length; i++) {
    const meeting = meetings[i];
    const round = i + 1;
    const country = meeting.country_name ?? meeting.location ?? `R${round}`;
    const flag = COUNTRY_FLAGS[country] ?? '🏁';
    const shortName = country;

    await sleep(2000);
    const raceSessions = await rawFetch<any>(
      `/sessions?meeting_key=${meeting.meeting_key}&session_type=Race`,
    );
    if (!raceSessions.length) continue;
    const raceSessionKey = raceSessions[0].session_key;

    let raceResults: any[] = [];
    try {
      await sleep(2000);
      raceResults = await getRaceResults(raceSessionKey);
    } catch (err: any) {
      console.warn(`  ⚠ race results unavailable for round ${round}: ${err.message}`);
      continue;
    }

    // Build team → finish positions (non-DNF only)
    const teamFinishes: Record<string, number[]> = {};
    for (const result of raceResults) {
      const team = carToTeam[result.driverNumber];
      if (!team || result.dnf) continue;
      if (!teamFinishes[team]) teamFinishes[team] = [];
      teamFinishes[team].push(result.position);
    }

    for (const [slug, teams] of Object.entries(puToTeams)) {
      const carPositions: number[] = teams.flatMap(t => teamFinishes[t] ?? []);
      if (carPositions.length === 0) continue;

      acc[slug].races++;
      const pts = calculatePowerUnitScore(carPositions);
      acc[slug].totalPoints += pts;
      acc[slug].rows.push({ round, flag, shortName, rPts: pts, tot: pts, carPositions });
    }

    console.log(`  ✓ Round ${round}`);
  }

  console.log(`Saving ${year} power unit HistoricalSeason + HistoricalRaceBreakdown documents…`);
  for (const [manufacturerSlug, data] of Object.entries(acc)) {
    const avgPointsPerRace = data.races > 0
      ? Math.round((data.totalPoints / data.races) * 100) / 100
      : 0;
    const totalPoints = Math.round(data.totalPoints * 100) / 100;

    // Fan-out: save identical data for every team PU slug that uses this manufacturer
    const teams = puToTeams[manufacturerSlug] ?? [];
    const assetSlugs = [...new Set(teams.map(t => TEAM_TO_PU_SLUG[t]).filter(Boolean))];

    for (const assetSlug of assetSlugs) {
      await HistoricalSeason.findOneAndUpdate(
        { assetSlug, season: year },
        { assetSlug, assetType: 'powerUnit', season: year, racesCompleted: data.races, totalPoints, avgPointsPerRace },
        { upsert: true, new: true },
      );
      for (const row of data.rows) {
        await HistoricalRaceBreakdown.findOneAndUpdate(
          { assetSlug, season: year, round: row.round },
          {
            assetSlug, season: year, round: row.round,
            flag: row.flag, shortName: row.shortName,
            rPts: row.rPts, btBonus: 0, pgScore: 0, tot: row.tot, dnf: false,
            carPositions: row.carPositions,
          },
          { upsert: true, new: true },
        );
      }
      console.log(`  ✓ ${assetSlug} (${year}): ${data.races} races, pts=${totalPoints.toFixed(1)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Seed pit crews for one year
// ---------------------------------------------------------------------------

async function seedPitCrews(
  year: number,
  meetings: any[],
  carToTeam: Record<number, string>,
): Promise<void> {
  console.log(`\n── Pit Crews ${year} ──`);

  // Remove stale team-level breakdown docs (assetSlug ends with "pit-crew", no car number suffix)
  const deleted = await HistoricalRaceBreakdown.deleteMany({ assetSlug: /pit-crew$/ });
  console.log(`  Deleted ${deleted.deletedCount} old team-level pit crew breakdown docs`);

  // Remove docs with unconverted stop times (avgStopTime > 5s means raw pit_duration was stored)
  const deletedOld = await HistoricalRaceBreakdown.deleteMany({ assetSlug: /pit-crew/, avgStopTime: { $gt: 5 } });
  console.log(`  Deleted ${deletedOld.deletedCount} pit crew breakdown docs with unconverted stop times`);

  const teamToCarNums = buildTeamToCarNums(carToTeam);

  type PitCrewRow = {
    round: number; flag: string; shortName: string; rPts: number; flBonus: number; tot: number;
    stopCount: number; avgStopTime: number; fastestStop: number; wasOverallFastest: boolean;
    stop1Time?: number; stop2Time?: number; stop3Time?: number;
  };
  // acc keyed by team name (e.g. 'Ferrari'); slugs are derived at save time per car number
  const acc: Record<string, { races: number; totalPoints: number; fastestStopCount: number; stopTimes: number[]; rows: PitCrewRow[] }> = {};
  for (const team of Object.keys(teamToCarNums)) {
    if (!TEAM_TO_PIT_SLUG_PREFIX[team]) continue; // skip unknown teams
    acc[team] = { races: 0, totalPoints: 0, fastestStopCount: 0, stopTimes: [], rows: [] };
  }

  for (let i = 0; i < meetings.length; i++) {
    const meeting = meetings[i];
    const round = i + 1;
    const country = meeting.country_name ?? meeting.location ?? `R${round}`;
    const flag = COUNTRY_FLAGS[country] ?? '🏁';
    const shortName = country;

    await sleep(2000);
    const raceSessions = await rawFetch<any>(
      `/sessions?meeting_key=${meeting.meeting_key}&session_type=Race`,
    );
    if (!raceSessions.length) continue;
    const raceSessionKey = raceSessions[0].session_key;

    let pitData: any[] = [];
    try {
      await sleep(2000);
      pitData = await getPitStopData(raceSessionKey);
    } catch (err: any) {
      console.warn(`  ⚠ pit data unavailable for round ${round}: ${err.message}`);
      continue;
    }

    // Build team → all stop times (across both cars) and best stop this race
    const teamBestStop: Record<string, number> = {};
    const teamAllStops: Record<string, number[]> = {};

    for (const entry of pitData) {
      const team = carToTeam[entry.driverNumber];
      if (!team || !entry.stopTimes?.length) continue;
      const best = Math.min(...entry.stopTimes);
      if (teamBestStop[team] === undefined || best < teamBestStop[team]) {
        teamBestStop[team] = best;
      }
      if (!teamAllStops[team]) teamAllStops[team] = [];
      teamAllStops[team].push(...entry.stopTimes);
    }

    // Need at least 2 teams to rank
    const teamsWithData = Object.keys(teamBestStop);
    if (teamsWithData.length < 2) continue;

    // Rank by fastest stop and avg stop time
    const fastestRanking = [...teamsWithData].sort((a, b) => teamBestStop[a] - teamBestStop[b]);
    const teamAvgStop: Record<string, number> = {};
    for (const team of teamsWithData) {
      const stops = teamAllStops[team];
      teamAvgStop[team] = stops.reduce((a, b) => a + b, 0) / stops.length;
    }
    const avgRanking = [...teamsWithData].sort((a, b) => teamAvgStop[a] - teamAvgStop[b]);

    for (const [team, data] of Object.entries(acc)) {
      if (!teamBestStop[team]) continue;

      data.races++;
      const teamStops = teamAllStops[team] ?? [];
      data.stopTimes.push(...teamStops);

      const fastestRank = fastestRanking.indexOf(team) + 1;
      const avgRank = avgRanking.indexOf(team) + 1;
      const pts = calculatePitCrewScore(fastestRank, avgRank);
      data.totalPoints += pts;

      const isFastest = fastestRank === 1;
      if (isFastest) data.fastestStopCount++;

      const stopCount = teamStops.length;
      const avgStopTime = stopCount > 0 ? Math.round((teamStops.reduce((a, b) => a + b, 0) / stopCount) * 1000) / 1000 : 0;
      const fastestStop = stopCount > 0 ? Math.min(...teamStops) : 0;
      const sorted = [...teamStops].sort((a, b) => a - b);

      data.rows.push({
        round, flag, shortName, rPts: pts, flBonus: isFastest ? 1 : 0, tot: pts,
        stopCount, avgStopTime, fastestStop, wasOverallFastest: isFastest,
        ...(sorted[0] !== undefined && { stop1Time: sorted[0] }),
        ...(sorted[1] !== undefined && { stop2Time: sorted[1] }),
        ...(sorted[2] !== undefined && { stop3Time: sorted[2] }),
      });
    }

    console.log(`  ✓ Round ${round}: ${teamsWithData.length} crews with data`);
  }

  console.log(`Saving ${year} pit crew HistoricalSeason + HistoricalRaceBreakdown documents…`);
  for (const [team, data] of Object.entries(acc)) {
    const slugPrefix = TEAM_TO_PIT_SLUG_PREFIX[team];
    if (!slugPrefix) continue;

    const carNums = teamToCarNums[team] ?? [];
    const avgPointsPerRace = data.races > 0
      ? Math.round((data.totalPoints / data.races) * 100) / 100
      : 0;
    const avgPitStopTime = data.stopTimes.length > 0
      ? Math.round((data.stopTimes.reduce((a, b) => a + b, 0) / data.stopTimes.length) * 1000) / 1000
      : undefined;

    // Save one HistoricalSeason per car slug
    for (const carNum of carNums) {
      const assetSlug = `${slugPrefix}-${carNum}`;
      await HistoricalSeason.findOneAndUpdate(
        { assetSlug, season: year },
        {
          assetSlug,
          assetType:        'pitCrew',
          season:           year,
          team,
          racesCompleted:   data.races,
          totalPoints:      Math.round(data.totalPoints * 100) / 100,
          avgPointsPerRace,
          fastestStopCount: data.fastestStopCount,
          ...(avgPitStopTime !== undefined && { avgPitStopTime }),
        },
        { upsert: true, new: true },
      );

      // Save one HistoricalRaceBreakdown per round per car slug
      for (const row of data.rows) {
        await HistoricalRaceBreakdown.findOneAndUpdate(
          { assetSlug, season: year, round: row.round },
          {
            assetSlug, season: year, round: row.round,
            flag: row.flag, shortName: row.shortName,
            rPts: row.rPts, flBonus: row.flBonus, btBonus: 0, pgScore: 0, tot: row.tot, dnf: false,
            stopCount: row.stopCount,
            avgStopTime: row.avgStopTime,
            fastestStop: row.fastestStop,
            wasOverallFastest: row.wasOverallFastest,
            ...(row.stop1Time !== undefined && { stop1Time: row.stop1Time }),
            ...(row.stop2Time !== undefined && { stop2Time: row.stop2Time }),
            ...(row.stop3Time !== undefined && { stop3Time: row.stop3Time }),
          },
          { upsert: true, new: true },
        );
      }
      console.log(`  ✓ ${assetSlug} (${year}): ${data.races} races, ${data.fastestStopCount} fastest stops, pts=${data.totalPoints.toFixed(1)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main() {
  await connectDB();

  for (const year of [2024, 2025]) {
    const carToTeam = year === 2024 ? CAR_TO_TEAM_2024 : CAR_TO_TEAM_2025;
    const puToTeams = year === 2024 ? PU_TO_TEAMS_2024 : PU_TO_TEAMS_2025;

    console.log(`\n════ ${year} ════`);
    console.log('Fetching meetings…');
    const allMeetings = await rawFetch<any>(`/meetings?year=${year}`);
    const meetings = allMeetings
      .filter((m: any) => !/test/i.test(m.meeting_name))
      .sort((a: any, b: any) => new Date(a.date_start).getTime() - new Date(b.date_start).getTime());
    console.log(`Found ${meetings.length} race meetings`);

    await seedPrincipals(year, meetings, carToTeam);
    await seedPowerUnits(year, meetings, carToTeam, puToTeams);
    await seedPitCrews(year, meetings, carToTeam);
  }

  console.log('\n✅ Non-driver historical seasons seeded successfully');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
