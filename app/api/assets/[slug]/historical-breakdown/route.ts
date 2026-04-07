import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { FINISH_POINTS } from '@/lib/otf-calculator';

// Allow up to 60s for the OpenF1 calls
export const maxDuration = 60;

// ─── Car number → driver slug mappings ───────────────────────────────────────

const CAR_TO_SLUG_2024: Record<number, string> = {
  1:  'max-verstappen',
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

const COUNTRY_FLAGS: Record<string, string> = {
  'Australia': '🇦🇺', 'China': '🇨🇳', 'Japan': '🇯🇵',
  'Bahrain': '🇧🇭', 'Saudi Arabia': '🇸🇦', 'United States': '🇺🇸', 'USA': '🇺🇸',
  'Canada': '🇨🇦', 'Monaco': '🇲🇨', 'Spain': '🇪🇸',
  'Austria': '🇦🇹', 'United Kingdom': '🇬🇧', 'UK': '🇬🇧', 'Belgium': '🇧🇪',
  'Hungary': '🇭🇺', 'Netherlands': '🇳🇱', 'Italy': '🇮🇹',
  'Azerbaijan': '🇦🇿', 'Singapore': '🇸🇬', 'Mexico': '🇲🇽',
  'Brazil': '🇧🇷', 'Qatar': '🇶🇦', 'Abu Dhabi': '🇦🇪', 'UAE': '🇦🇪',
};

const BASE_URL = 'https://api.openf1.org/v1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function of1Fetch<T>(path: string, params: Record<string, string | number> = {}): Promise<T[]> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ''}`;
  let res = await fetch(url);
  if (res.status === 429) {
    await sleep(4000);
    res = await fetch(url);
  }
  if (!res.ok) throw new Error(`OpenF1 ${res.status}: ${url}`);
  return res.json();
}

function deriveQStage(pos: number): 'Q1' | 'Q2' | 'Q3' {
  if (pos <= 10) return 'Q3';
  if (pos <= 15) return 'Q2';
  return 'Q1';
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { slug } = await params;
  const seasonParam = req.nextUrl.searchParams.get('season');
  const season = seasonParam ? parseInt(seasonParam, 10) : null;

  if (season !== 2024 && season !== 2025) {
    return NextResponse.json({ error: 'season must be 2024 or 2025' }, { status: 400 });
  }

  const carToSlug = season === 2024 ? CAR_TO_SLUG_2024 : CAR_TO_SLUG_2025;
  const teamBySlug = season === 2024 ? TEAMS_2024 : TEAMS_2025;

  // Resolve car number for this driver
  const slugToCarNum = Object.fromEntries(Object.entries(carToSlug).map(([num, s]) => [s, Number(num)]));
  const carNum = slugToCarNum[slug];
  if (!carNum) return NextResponse.json({ error: 'Driver not found for this season' }, { status: 404 });

  const myTeam = teamBySlug[slug];

  // Find teammate car number (same team, different slug)
  const teammateSlug = Object.entries(teamBySlug).find(
    ([s, t]) => t === myTeam && s !== slug && slugToCarNum[s] != null,
  )?.[0] ?? null;
  const teammateCarNum = teammateSlug ? slugToCarNum[teammateSlug] : null;

  // Fetch all meetings for the season
  const allMeetings = await of1Fetch<any>('/meetings', { year: season });
  const meetings = allMeetings
    .filter((m: any) => !/test/i.test(m.meeting_name))
    .sort((a: any, b: any) => new Date(a.date_start).getTime() - new Date(b.date_start).getTime());

  const rows: any[] = [];

  for (let i = 0; i < meetings.length; i++) {
    const meeting = meetings[i];
    const round   = i + 1;
    const country  = meeting.country_name ?? meeting.location ?? `R${round}`;
    const flag     = COUNTRY_FLAGS[country] ?? '🏁';
    const shortName = country;

    try {
      // Race session
      await sleep(300);
      const raceSessions = await of1Fetch<any>('/sessions', {
        meeting_key:  meeting.meeting_key,
        session_type: 'Race',
      });
      if (!raceSessions.length) continue;
      const raceKey = raceSessions[0].session_key;

      // Qualifying session
      await sleep(300);
      const qualSessions = await of1Fetch<any>('/sessions', {
        meeting_key:  meeting.meeting_key,
        session_type: 'Qualifying',
      });
      const qualKey: number | null = qualSessions[0]?.session_key ?? null;

      // Race results: positions
      await sleep(300);
      const positions = await of1Fetch<any>('/position', { session_key: raceKey });
      await sleep(300);
      const laps = await of1Fetch<any>('/laps', { session_key: raceKey });

      // Latest position per driver
      const lastPos = new Map<number, { position: number; date: string }>();
      for (const p of positions) {
        const cur = lastPos.get(p.driver_number);
        if (!cur || p.date > cur.date) lastPos.set(p.driver_number, { position: p.position, date: p.date });
      }

      // Max lap per driver for DNF detection
      const maxLap = new Map<number, number>();
      for (const lap of laps) {
        const cur = maxLap.get(lap.driver_number) ?? 0;
        if (lap.lap_number > cur) maxLap.set(lap.driver_number, lap.lap_number);
      }
      const raceLaps = maxLap.size > 0 ? Math.max(...maxLap.values()) : 0;

      const myPos = lastPos.get(carNum);
      if (!myPos) continue;

      const finishPos = myPos.position;
      const isDnf = (maxLap.get(carNum) ?? 0) < raceLaps - 1;

      const teammateFinishPos = teammateCarNum ? lastPos.get(teammateCarNum)?.position ?? null : null;
      const teammateDnf = teammateCarNum
        ? (maxLap.get(teammateCarNum) ?? 0) < raceLaps - 1
        : false;

      // Qualifying position
      let qPos: number | null = null;
      let qStage: 'Q1' | 'Q2' | 'Q3' | null = null;
      if (qualKey) {
        await sleep(300);
        const qualLaps = await of1Fetch<any>('/laps', { session_key: qualKey });
        const bestLap = new Map<number, number>();
        for (const lap of qualLaps) {
          if (lap.lap_duration == null || lap.is_pit_out_lap) continue;
          const cur = bestLap.get(lap.driver_number);
          if (cur === undefined || lap.lap_duration < cur) bestLap.set(lap.driver_number, lap.lap_duration);
        }
        const sorted = Array.from(bestLap.entries()).sort((a, b) => a[1] - b[1]);
        const myQIdx = sorted.findIndex(([num]) => num === carNum);
        if (myQIdx >= 0) {
          qPos = myQIdx + 1;
          qStage = deriveQStage(qPos);
        }
      }

      // Scoring
      if (isDnf) {
        rows.push({ round, flag, shortName, qPos, qStage, rPts: 0, flBonus: 0, btBonus: 0, pgScore: 0, total: 0, dnf: true });
        continue;
      }

      const rPts    = (FINISH_POINTS[finishPos] ?? 0) + 1;
      const flBonus = 0; // not available from OpenF1 without additional fetch
      const btBonus = (teammateFinishPos != null && !teammateDnf && finishPos < teammateFinishPos) ? 3 : 0;

      let pgScore = 0;
      if (qPos != null) {
        const delta = qPos - finishPos;
        if (delta > 0) {
          pgScore = Math.min(delta * 2, 10);
        } else if (delta < 0) {
          const lost = -delta;
          pgScore = qPos <= 10 ? -Math.min(lost * 2, 10) : -Math.min(lost, 5);
        }
      }

      const total = rPts + btBonus + pgScore;

      rows.push({ round, flag, shortName, qPos, qStage, rPts, flBonus, btBonus, pgScore, total, dnf: false });
    } catch (err: any) {
      console.warn(`  ⚠ Round ${round} (${country}): ${err.message}`);
      continue;
    }
  }

  const totals = rows.reduce(
    (acc, r) => ({
      rPts:    acc.rPts    + r.rPts,
      flBonus: acc.flBonus + r.flBonus,
      btBonus: acc.btBonus + r.btBonus,
      pgScore: acc.pgScore + r.pgScore,
      total:   acc.total   + r.total,
    }),
    { rPts: 0, flBonus: 0, btBonus: 0, pgScore: 0, total: 0 },
  );

  const qCounts = { Q3: 0, Q2: 0, Q1: 0 };
  for (const r of rows) if (r.qStage) qCounts[r.qStage as 'Q1' | 'Q2' | 'Q3']++;

  return NextResponse.json({ rows, totals, qCounts, season });
}
