import {
  RaceWeekendData,
  QualifyingDriverResult,
  SprintResult,
  SprintQualiResult,
  RaceDriverResult,
  PrincipalRaceResult,
  CarPitData,
  CarFinishData,
} from './index';

const BASE_URL = 'https://api.openf1.org/v1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function get(path: string, params: Record<string, string | number> = {}): Promise<any[]> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ''}`;

  let delay = 5000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`OpenF1 ${res.status}: GET ${url}`);
    return res.json();
  }
  throw new Error(`OpenF1 max retries: GET ${url}`);
}

// ---------------------------------------------------------------------------
// Individual fetchers
// ---------------------------------------------------------------------------

export async function fetchSessions(meetingKey: number): Promise<any[]> {
  return get('/sessions', { meeting_key: meetingKey });
}

export async function fetchSessionResult(sessionKey: number): Promise<any[]> {
  return get('/session_result', { session_key: sessionKey });
}

export async function fetchStartingGrid(sessionKey: number): Promise<any[]> {
  return get('/starting_grid', { session_key: sessionKey });
}

export async function fetchPitStops(sessionKey: number): Promise<any[]> {
  return get('/pit', { session_key: sessionKey });
}

export async function fetchDrivers(sessionKey: number): Promise<any[]> {
  return get('/drivers', { session_key: sessionKey });
}

export async function fetchLaps(sessionKey: number): Promise<any[]> {
  return get('/laps', { session_key: sessionKey });
}

// ---------------------------------------------------------------------------
// Status normalisation — uses boolean fields from session_result objects
// ---------------------------------------------------------------------------

function normaliseStatus(result: any): 'Finished' | 'DNF' | 'DSQ' {
  if (result.dsq === true) return 'DSQ';
  if (result.dnf === true || result.dns === true) return 'DNF';
  return 'Finished';
}

// ---------------------------------------------------------------------------
// Fastest lap detection — find driver with minimum valid lap_duration
// ---------------------------------------------------------------------------

function findFastestLapDriver(laps: any[]): number | null {
  let fastest: number | null = null;
  let fastestDriver: number | null = null;

  for (const lap of laps) {
    // Skip null durations and pit-out laps
    if (lap.lap_duration == null) continue;
    if (lap.is_pit_out_lap === true) continue;

    if (fastest === null || lap.lap_duration < fastest) {
      fastest = lap.lap_duration;
      fastestDriver = lap.driver_number;
    }
  }

  return fastestDriver;
}

// ---------------------------------------------------------------------------
// Qualifying helpers
// ---------------------------------------------------------------------------

// OpenF1 returns separate sessions for Q1, Q2, Q3.
// We need to reconstruct which stage each driver reached.
async function buildQualifyingResults(
  qualSessions: any[],
  allDriversByTeam: Map<number, string>, // driverNumber → teamName
): Promise<QualifyingDriverResult[]> {
  // Sort Q1 / Q2 / Q3 by name
  const q1Session = qualSessions.find(s => /\bQ1\b/i.test(s.session_name) || qualSessions.length === 1);
  const q2Session = qualSessions.find(s => /\bQ2\b/i.test(s.session_name));
  const q3Session = qualSessions.find(s => /\bQ3\b/i.test(s.session_name));

  // Collect driver numbers per stage
  const q2Drivers = new Set<number>();
  const q3Drivers = new Set<number>();

  if (q2Session) {
    const q2Results = await fetchSessionResult(q2Session.session_key);
    await sleep(400);
    for (const r of q2Results) q2Drivers.add(r.driver_number);
  }
  if (q3Session) {
    const q3Results = await fetchSessionResult(q3Session.session_key);
    await sleep(400);
    for (const r of q3Results) q3Drivers.add(r.driver_number);
  }

  // Final qualifying result comes from the highest session each driver reached
  const finalSession = q3Session ?? q2Session ?? q1Session;
  if (!finalSession) return [];

  // Q1 results give us all participants and final positions for Q1-only drivers
  const q1Results = q1Session ? await fetchSessionResult(q1Session.session_key) : [];
  await sleep(400);
  const finalResults = await fetchSessionResult(finalSession.session_key);
  await sleep(400);

  // Build final-position map: use the highest-stage result for each driver
  const finalPosMap = new Map<number, { position: number; isDSQ: boolean; isDNQ: boolean }>();

  // Start with Q1 results
  for (const r of q1Results) {
    const status = normaliseStatus(r);
    finalPosMap.set(r.driver_number, {
      position: r.position,
      isDSQ:    status === 'DSQ',
      isDNQ:    status === 'DNF', // dns in qualifying = did not qualify
    });
  }
  // Override with final-stage results for drivers who advanced
  for (const r of finalResults) {
    const status = normaliseStatus(r);
    finalPosMap.set(r.driver_number, {
      position: r.position,
      isDSQ:    status === 'DSQ',
      isDNQ:    false, // reached a higher stage → qualified
    });
  }

  return Array.from(finalPosMap.entries()).map(([driverNumber, data]) => {
    const status: 'Qualified' | 'DNQ' | 'DSQ' = data.isDSQ ? 'DSQ' : data.isDNQ ? 'DNQ' : 'Qualified';
    const reachedQ2 = q2Drivers.has(driverNumber);
    const reachedQ3 = q3Drivers.has(driverNumber);

    return {
      driverNumber,
      teamName:      allDriversByTeam.get(driverNumber) ?? 'Unknown',
      finalPosition: status === 'Qualified' ? data.position : null,
      reachedQ2,
      reachedQ3,
      setLapTime:    status === 'Qualified',
      status,
    };
  });
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export async function buildRaceWeekendData(
  meetingKey: number,
  powerUnitMap: Record<string, string>, // teamName → manufacturer
): Promise<RaceWeekendData> {
  // 1. Fetch all sessions
  const allSessions: any[] = await fetchSessions(meetingKey);
  await sleep(400);

  const raceName   = allSessions[0]?.meeting_name ?? `Meeting ${meetingKey}`;
  const sessionKey = allSessions[0]?.session_key ?? 0;

  // Identify sessions
  const qualSessions  = allSessions.filter(s => /qualifying/i.test(s.session_name) && !/sprint/i.test(s.session_name));
  const sprintSession = allSessions.find(s => /^sprint$/i.test(s.session_name.trim()));
  const raceSession   = allSessions.find(s => /^race$/i.test(s.session_name.trim()));

  if (!raceSession) throw new Error(`No Race session found for meeting ${meetingKey}`);

  // 2. Fetch race session data (laps in parallel for fastest lap detection)
  const [raceResults, raceGridRaw, raceDrivers, pitStopsRaw, raceLaps] = await Promise.all([
    fetchSessionResult(raceSession.session_key),
    fetchStartingGrid(raceSession.session_key),
    fetchDrivers(raceSession.session_key),
    fetchPitStops(raceSession.session_key),
    fetchLaps(raceSession.session_key),
  ]);

  // Build driver maps
  const driverTeamMap = new Map<number, string>(); // driverNumber → teamName
  for (const d of raceDrivers) driverTeamMap.set(d.driver_number, d.team_name ?? 'Unknown');

  // 3. Qualifying results (needed for grid fallback)
  let qualifyingResults: QualifyingDriverResult[] = [];
  if (qualSessions.length > 0) {
    qualifyingResults = await buildQualifyingResults(qualSessions, driverTeamMap);
  }

  // Build grid map — fall back to qualifying positions if starting_grid is empty
  const gridMap = new Map<number, number>(); // driverNumber → gridPosition
  if (raceGridRaw.length > 0) {
    for (const g of raceGridRaw) gridMap.set(g.driver_number, g.position ?? 20);
  } else {
    // Fallback: use qualifying final positions as grid positions
    for (const q of qualifyingResults) {
      if (q.finalPosition != null) {
        gridMap.set(q.driverNumber, q.finalPosition);
      }
    }
  }

  // 4. Fastest lap — driver with minimum valid lap_duration
  const fastestLapDriver = findFastestLapDriver(raceLaps);

  // 5. Build race driver results
  const raceDriverResults: RaceDriverResult[] = raceResults.map((r: any) => ({
    driverNumber:   r.driver_number,
    teamName:       driverTeamMap.get(r.driver_number) ?? 'Unknown',
    finishPosition: normaliseStatus(r) === 'Finished' ? r.position : null,
    startPosition:  gridMap.get(r.driver_number) ?? 20,
    status:         normaliseStatus(r),
    fastestLap:     r.driver_number === fastestLapDriver,
  }));

  // 6. Pit data
  const pitByDriver = new Map<number, number[]>();
  for (const p of pitStopsRaw) {
    if (p.pit_duration == null) continue;
    if (p.pit_duration < 15 || p.pit_duration > 60) continue; // filter noise
    const arr = pitByDriver.get(p.driver_number) ?? [];
    arr.push(Math.round(p.pit_duration * 100) / 100);
    pitByDriver.set(p.driver_number, arr);
  }

  const pitData: CarPitData[] = raceDrivers.map((d: any) => ({
    driverNumber: d.driver_number,
    carNumber:    d.driver_number,
    teamName:     d.team_name ?? 'Unknown',
    pitStops:     pitByDriver.get(d.driver_number) ?? [],
  }));

  // 7. Car finish data for power units
  const carFinishData: CarFinishData[] = raceResults.map((r: any) => ({
    driverNumber:   r.driver_number,
    manufacturer:   powerUnitMap[driverTeamMap.get(r.driver_number) ?? ''] ?? 'Unknown',
    finishPosition: normaliseStatus(r) === 'Finished' ? r.position : null,
  }));

  // 8. Principal results — group by team
  const teamDrivers = new Map<string, { finish: number | null; qual: number | null }[]>();
  for (const r of raceResults) {
    const team = driverTeamMap.get(r.driver_number) ?? 'Unknown';
    const arr  = teamDrivers.get(team) ?? [];
    arr.push({
      finish: normaliseStatus(r) === 'Finished' ? r.position : null,
      qual:   null, // filled after qualifying
    });
    teamDrivers.set(team, arr);
  }

  // Attach qualifying positions to team driver entries
  const qualPosMap = new Map<number, number | null>();
  for (const q of qualifyingResults) qualPosMap.set(q.driverNumber, q.finalPosition);

  const principalResults: PrincipalRaceResult[] = Array.from(teamDrivers.entries()).map(([teamName, drivers]) => ({
    teamName,
    driver1WeeklyPoints:       0,    // enriched in index.ts after scoring
    driver2WeeklyPoints:       0,    // enriched in index.ts after scoring
    driver1FinishPosition:     drivers[0]?.finish ?? null,
    driver2FinishPosition:     drivers[1]?.finish ?? null,
    driver1QualifyingPosition: null, // updated below
    driver2QualifyingPosition: null,
    pitCrew1AvgStopRank:       null, // enriched in index.ts after pit crew scoring
    pitCrew2AvgStopRank:       null,
  }));

  // Patch qualifying positions into principal results
  for (const r of qualifyingResults) {
    const team = driverTeamMap.get(r.driverNumber);
    if (!team) continue;
    const pr = principalResults.find(p => p.teamName === team);
    if (!pr) continue;
    if (pr.driver1QualifyingPosition === null) {
      pr.driver1QualifyingPosition = r.finalPosition;
    } else {
      pr.driver2QualifyingPosition = r.finalPosition;
    }
  }

  // 9. Sprint results (optional)
  let sprintResults: SprintResult[] | undefined;
  let sprintQualiResults: SprintQualiResult[] | undefined;
  if (sprintSession) {
    const sprintQualSession = allSessions.find(s => /sprint.*qual/i.test(s.session_name));

    const [sprintRaw, sprintGridRaw, sqRaw] = await Promise.all([
      fetchSessionResult(sprintSession.session_key),
      fetchStartingGrid(sprintSession.session_key),
      sprintQualSession ? fetchSessionResult(sprintQualSession.session_key) : Promise.resolve([]),
    ]);

    // Always capture sprint qualifying positions for scoring
    const sprintQualPositions = new Map<number, number>(
      sqRaw.map((r: any) => [r.driver_number, r.position as number]),
    );

    if (sprintQualPositions.size > 0) {
      sprintQualiResults = Array.from(sprintQualPositions.entries()).map(([driverNumber, position]) => ({
        driverNumber,
        position,
      }));
    }

    // Build sprint grid: prefer explicit grid, fall back to sprint quali positions
    const sprintGridMap = new Map<number, number>();
    if (sprintGridRaw.length > 0) {
      for (const g of sprintGridRaw) sprintGridMap.set(g.driver_number, g.position ?? 20);
    } else if (sprintQualPositions.size > 0) {
      for (const [dn, pos] of sprintQualPositions) sprintGridMap.set(dn, pos);
    }

    sprintResults = sprintRaw.map((r: any) => ({
      driverNumber:   r.driver_number,
      finishPosition: normaliseStatus(r) === 'Finished' ? r.position : null,
      startPosition:  sprintGridMap.get(r.driver_number) ?? 20,
      status:         normaliseStatus(r),
    }));
  }

  return {
    sessionKey,
    meetingKey,
    raceName,
    hasSprint: !!sprintSession,
    qualifyingResults,
    sprintResults,
    sprintQualiResults,
    raceResults:      raceDriverResults,
    principalResults,
    pitData,
    carFinishData,
  };
}
