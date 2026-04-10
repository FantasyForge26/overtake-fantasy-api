/**
 * OpenF1 API service
 * Docs: https://openf1.org
 */

const BASE_URL = 'https://api.openf1.org/v1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface OF1Meeting {
  meeting_key: number;
  meeting_name: string;
  date_start: string;
  year: number;
}

export interface OF1Session {
  session_key: number;
  session_type: string;
  session_name: string;
  date_start: string;
  date_end: string;
  meeting_key: number;
  year: number;
}

interface OF1Position {
  session_key: number;
  driver_number: number;
  position: number;
  date: string;
}

interface OF1Lap {
  session_key: number;
  driver_number: number;
  lap_number: number;
  lap_duration: number | null;
  date_start: string;
  is_pit_out_lap: boolean;
}

interface OF1Pit {
  session_key: number;
  driver_number: number;
  pit_duration: number | null;
  lap_number: number;
  date: string;
}

// ---------------------------------------------------------------------------
// HTTP helper
// Keys are written verbatim (so callers can pass 'date>=' as a key).
// Only values are percent-encoded.
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, params: Record<string, string | number> = {}): Promise<T[]> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}${k.endsWith('=') ? '' : '='}${encodeURIComponent(String(v))}`)
    .join('&');
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ''}`;
  let res = await fetch(url);
  if (res.status === 429) {
    await sleep(3000);
    res = await fetch(url);
  }
  if (!res.ok) throw new Error(`OpenF1 ${res.status}: GET ${url}`);
  return res.json() as Promise<T[]>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the session object for a given year / round / session type.
 * Testing meetings are excluded; remaining meetings are sorted ascending
 * by date_start and `round` is used as a 1-based index.
 */
export async function getSession(
  year: number,
  sessionType: 'Race' | 'Qualifying' | 'Sprint',
  round: number,
): Promise<OF1Session> {
  const meetings = await apiFetch<OF1Meeting>('/meetings', { year });

  const sorted = meetings
    .filter(m => !/test/i.test(m.meeting_name))
    .sort((a, b) => new Date(a.date_start).getTime() - new Date(b.date_start).getTime());

  const meeting = sorted[round - 1];
  if (!meeting) throw new Error(`No meeting found for ${year} round ${round}`);

  const sessions = await apiFetch<OF1Session>('/sessions', {
    meeting_key: meeting.meeting_key,
    session_type: sessionType,
  });
  if (!sessions.length) {
    throw new Error(`No ${sessionType} session for ${year} round ${round} (meeting_key=${meeting.meeting_key})`);
  }

  return sessions[0];
}

/**
 * Returns final race positions for each driver.
 * Position is the driver's last-recorded position in the session.
 * DNF is inferred when a driver completed at least 2 fewer laps than the race winner.
 */
export async function getRaceResults(
  sessionKey: number,
): Promise<Array<{ driverNumber: number; position: number; dnf: boolean }>> {
  await sleep(500);
  const positions = await apiFetch<OF1Position>('/position', { session_key: sessionKey });
  await sleep(500);
  const laps = await apiFetch<OF1Lap>('/laps', { session_key: sessionKey });

  // Latest position record per driver
  const lastPos = new Map<number, { position: number; date: string }>();
  for (const p of positions) {
    const cur = lastPos.get(p.driver_number);
    if (!cur || p.date > cur.date) {
      lastPos.set(p.driver_number, { position: p.position, date: p.date });
    }
  }

  // Max lap completed per driver
  const maxLap = new Map<number, number>();
  for (const lap of laps) {
    const cur = maxLap.get(lap.driver_number) ?? 0;
    if (lap.lap_number > cur) maxLap.set(lap.driver_number, lap.lap_number);
  }
  const raceLaps = maxLap.size > 0 ? Math.max(...maxLap.values()) : 0;

  return Array.from(lastPos.entries())
    .map(([driverNumber, { position }]) => ({
      driverNumber,
      position,
      dnf: (maxLap.get(driverNumber) ?? 0) < raceLaps - 1,
    }))
    .sort((a, b) => a.position - b.position);
}

/**
 * Returns qualifying results sorted by best lap time.
 * qualifyingRound reflects the highest segment each driver reached:
 *   positions 1–10  → Q3
 *   positions 11–15 → Q2
 *   positions 16+   → Q1
 * Pit-out laps and laps with no recorded time are excluded.
 */
export async function getQualifyingResults(
  sessionKey: number,
): Promise<Array<{ driverNumber: number; position: number; qualifyingRound: 'Q1' | 'Q2' | 'Q3' }>> {
  await sleep(500);
  const laps = await apiFetch<OF1Lap>('/laps', { session_key: sessionKey });

  const bestLap = new Map<number, number>();
  for (const lap of laps) {
    if (lap.lap_duration == null || lap.is_pit_out_lap) continue;
    const cur = bestLap.get(lap.driver_number);
    if (cur === undefined || lap.lap_duration < cur) {
      bestLap.set(lap.driver_number, lap.lap_duration);
    }
  }

  return Array.from(bestLap.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([driverNumber], idx) => {
      const position = idx + 1;
      const qualifyingRound: 'Q1' | 'Q2' | 'Q3' =
        position <= 10 ? 'Q3' : position <= 15 ? 'Q2' : 'Q1';
      return { driverNumber, position, qualifyingRound };
    });
}

/**
 * Returns pit stop data per driver for the session.
 * Uses raw pit_duration (no offset subtraction). Filters out nulls and
 * obvious data errors (< 15s or > 60s). Stop times are rounded to 2 dp.
 * fastestStopOverall marks the driver with the single fastest stop.
 */
export async function getPitStopData(
  sessionKey: number,
): Promise<Array<{ driverNumber: number; stopTimes: number[]; fastestStopOverall: boolean }>> {
  await sleep(500);
  const pits = await apiFetch<OF1Pit>('/pit', { session_key: sessionKey });

  const byDriver = new Map<number, number[]>();
  for (const p of pits) {
    if (p.pit_duration == null) continue;
    if (p.pit_duration < 15 || p.pit_duration > 60) continue;
    const stopTime = Math.round(p.pit_duration * 100) / 100;
    const stops = byDriver.get(p.driver_number) ?? [];
    stops.push(stopTime);
    byDriver.set(p.driver_number, stops);
  }

  // Driver with the globally fastest single stationary stop
  let fastestTime = Infinity;
  let fastestDriver = -1;
  for (const [driverNumber, stops] of byDriver.entries()) {
    const min = Math.min(...stops);
    if (min < fastestTime) {
      fastestTime = min;
      fastestDriver = driverNumber;
    }
  }

  return Array.from(byDriver.entries()).map(([driverNumber, stopTimes]) => ({
    driverNumber,
    stopTimes,
    fastestStopOverall: driverNumber === fastestDriver,
  }));
}

/**
 * Returns starting grid positions by taking the first-recorded position
 * per driver within the first 5 minutes of the session.
 */
export async function getGridPositions(
  sessionKey: number,
): Promise<Array<{ driverNumber: number; gridPosition: number }>> {
  await sleep(500);
  const sessions = await apiFetch<OF1Session>('/sessions', { session_key: sessionKey });
  if (!sessions.length) throw new Error(`Session not found: ${sessionKey}`);

  const { date_start } = sessions[0];
  const cutoff = new Date(new Date(date_start).getTime() + 5 * 60 * 1000).toISOString();

  await sleep(500);
  const positions = await apiFetch<OF1Position>('/position', {
    session_key: sessionKey,
    'date>=': date_start,
    'date<=': cutoff,
  });

  // Earliest position record per driver = grid slot
  const gridMap = new Map<number, { position: number; date: string }>();
  for (const p of positions) {
    const cur = gridMap.get(p.driver_number);
    if (!cur || p.date < cur.date) {
      gridMap.set(p.driver_number, { position: p.position, date: p.date });
    }
  }

  return Array.from(gridMap.entries())
    .map(([driverNumber, { position }]) => ({ driverNumber, gridPosition: position }))
    .sort((a, b) => a.gridPosition - b.gridPosition);
}
