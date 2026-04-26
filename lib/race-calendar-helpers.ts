const OPENF1_BASE = 'https://api.openf1.org/v1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Finds the OpenF1 meeting_key for a race weekend by matching the race session
 * date against the /sessions endpoint for the given year.
 *
 * @param raceDate - The scheduled race date (UTC)
 * @param country  - Optional country name for additional matching (case-insensitive)
 * @returns meeting_key number or null if not found
 */
export async function findMeetingKeyForDate(
  raceDate: Date,
  country?: string,
): Promise<number | null> {
  const year = raceDate.getUTCFullYear();
  const url  = `${OPENF1_BASE}/sessions?session_type=Race&year=${year}`;

  let sessions: any[] | null = null;
  let delay = 5000;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (!res.ok) return null;
    sessions = await res.json();
    break;
  }

  if (!sessions) return null;

  const raceDateDay = raceDate.toISOString().slice(0, 10); // 'YYYY-MM-DD'

  for (const session of sessions) {
    if (!session.date_start || !session.meeting_key) continue;

    const sessionDay = new Date(session.date_start).toISOString().slice(0, 10);
    if (sessionDay !== raceDateDay) continue;

    if (country) {
      const sessionCountry = (session.country_name ?? '').toLowerCase();
      const targetCountry  = country.toLowerCase();
      if (!sessionCountry.includes(targetCountry) && !targetCountry.includes(sessionCountry)) {
        continue;
      }
    }

    return session.meeting_key as number;
  }

  return null;
}

/**
 * Returns the lock time for boost selections: 5 minutes before the earliest
 * scoring session of the race weekend. For sprint weekends this is the earlier
 * of qualifyingDate and sprintDate; for standard weekends it is qualifyingDate.
 */
export function firstSessionLockTime(race: {
  raceDate:      Date | string;
  qualifyingDate: Date | string;
  sprintDate?:   Date | string | null;
  isSprint?:     boolean;
}): Date {
  const dates = [new Date(race.qualifyingDate)];
  if (race.isSprint && race.sprintDate) {
    dates.push(new Date(race.sprintDate));
  }
  const earliest = new Date(Math.min(...dates.map(d => d.getTime())));
  return new Date(earliest.getTime() - 5 * 60 * 1000);
}
