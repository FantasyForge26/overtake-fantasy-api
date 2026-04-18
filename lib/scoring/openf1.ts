import {
  RaceWeekendData,
  QualifyingDriverResult,
  SprintResult,
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
// Status normalisation
// ---------------------------------------------------------------------------

function normaliseStatus(raw: string | undefined | null): 'Finished' | 'DNF' | 'DSQ' {
  if (!raw) return 'DNF';
  const s = raw.toLowerCase();
  if (s.includes('disq') || s.includes('dsq')) return 'DSQ';
  if (s.includes('dnf') || s.includes('retired') || s.includes('accident') ||
      s.includes('collision') || s.includes('mechanical') || s.includes('withdrew')) return 'DNF';
  return 'Finished';
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
  const finalPosMap = new Map<number, { position: number; status: string; setLapTime: boolean }>();

  // Start with Q1 results
  for (const r of q1Results) {
    finalPosMap.set(r.driver_number, {
      position:   r.position,
      status:     r.status ?? 'Finished',
      setLapTime: !!r.lap_duration || r.status?.toLowerCase() !== 'dnq',
    });
  }
  // Override with final-stage results for drivers who advanced
  for (const r of finalResults) {
    finalPosMap.set(r.driver_number, {
      position:   r.position,
      status:     r.status ?? 'Finished',
      setLapTime: true,
    });
  }

  return Array.from(finalPosMap.entries()).map(([driverNumber, data]) => {
    const isDSQ = data.status?.toLowerCase().includes('dsq') ||
                  data.status?.toLowerCase().includes('disq');
    const isDNQ = !data.setLapTime ||
                  data.status?.toLowerCase().includes('dnq') ||
                  data.status?.toLowerCase().includes('did not');

    const status: 'Qualified' | 'DNQ' | 'DSQ' = isDSQ ? 'DSQ' : isDNQ ? 'DNQ' : 'Qualified';
    const reachedQ2 = q2Drivers.has(driverNumber);
    const reachedQ3 = q3Drivers.has(driverNumber);

    return {
      driverNumber,
      teamName:      allDriversByTeam.get(driverNumber) ?? 'Unknown',
      finalPosition: status === 'Qualified' ? data.position : null,
      reachedQ2,
      reachedQ3,
      setLapTime:    data.setLapTime,
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

  // 2. Fetch race session data
  const [raceResults, raceGrid, raceDrivers, pitStopsRaw] = await Promise.all([
    fetchSessionResult(raceSession.session_key),
    fetchStartingGrid(raceSession.session_key),
    fetchDrivers(raceSession.session_key),
    fetchPitStops(raceSession.session_key),
  ]);

  // Build driver maps
  const driverTeamMap = new Map<number, string>(); // driverNumber → teamName
  for (const d of raceDrivers) driverTeamMap.set(d.driver_number, d.team_name ?? 'Unknown');

  const gridMap = new Map<number, number>(); // driverNumber → gridPosition
  for (const g of raceGrid) gridMap.set(g.driver_number, g.position ?? 20);

  // 3. Build race driver results
  const raceDriverResults: RaceDriverResult[] = raceResults.map((r: any) => ({
    driverNumber:   r.driver_number,
    teamName:       driverTeamMap.get(r.driver_number) ?? 'Unknown',
    finishPosition: normaliseStatus(r.status) === 'Finished' ? r.position : null,
    startPosition:  gridMap.get(r.driver_number) ?? 20,
    status:         normaliseStatus(r.status),
    fastestLap:     !!r.is_fastest_lap || !!r.fastest_lap,
  }));

  // 4. Pit data
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

  // 5. Car finish data for power units
  const carFinishData: CarFinishData[] = raceResults.map((r: any) => ({
    driverNumber:   r.driver_number,
    manufacturer:   powerUnitMap[driverTeamMap.get(r.driver_number) ?? ''] ?? 'Unknown',
    finishPosition: normaliseStatus(r.status) === 'Finished' ? r.position : null,
  }));

  // 6. Principal results — group by team
  const teamDrivers = new Map<string, { finish: number | null; qual: number | null }[]>();
  for (const r of raceResults) {
    const team = driverTeamMap.get(r.driver_number) ?? 'Unknown';
    const arr  = teamDrivers.get(team) ?? [];
    arr.push({
      finish: normaliseStatus(r.status) === 'Finished' ? r.position : null,
      qual:   null, // filled after qualifying
    });
    teamDrivers.set(team, arr);
  }

  // 7. Qualifying results
  let qualifyingResults: QualifyingDriverResult[] = [];
  if (qualSessions.length > 0) {
    qualifyingResults = await buildQualifyingResults(qualSessions, driverTeamMap);
  }

  // Attach qualifying positions to team driver entries
  const qualPosMap = new Map<number, number | null>();
  for (const q of qualifyingResults) qualPosMap.set(q.driverNumber, q.finalPosition);

  const principalResults: PrincipalRaceResult[] = Array.from(teamDrivers.entries()).map(([teamName, drivers]) => ({
    teamName,
    driver1FinishPosition:     drivers[0]?.finish ?? null,
    driver2FinishPosition:     drivers[1]?.finish ?? null,
    driver1QualifyingPosition: null, // updated below
    driver2QualifyingPosition: null,
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

  // 8. Sprint results (optional)
  let sprintResults: SprintResult[] | undefined;
  if (sprintSession) {
    const [sprintRaw, sprintGrid] = await Promise.all([
      fetchSessionResult(sprintSession.session_key),
      fetchStartingGrid(sprintSession.session_key),
    ]);
    const sprintGridMap = new Map<number, number>();
    for (const g of sprintGrid) sprintGridMap.set(g.driver_number, g.position ?? 20);

    sprintResults = sprintRaw.map((r: any) => ({
      driverNumber:   r.driver_number,
      finishPosition: normaliseStatus(r.status) === 'Finished' ? r.position : null,
      startPosition:  sprintGridMap.get(r.driver_number) ?? 20,
      status:         normaliseStatus(r.status),
    }));
  }

  return {
    sessionKey,
    meetingKey,
    raceName,
    hasSprint: !!sprintSession,
    qualifyingResults,
    sprintResults,
    raceResults:      raceDriverResults,
    principalResults,
    pitData,
    carFinishData,
  };
}
