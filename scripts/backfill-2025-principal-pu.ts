/**
 * backfill-2025-principal-pu.ts
 *
 * Fetches 2025 race results from OpenF1 and inserts HistoricalRaceBreakdown docs
 * for all 2025 principal and power-unit asset slugs.
 *
 * Uses the same scoring functions as the live otf-calculator:
 *   - calculatePrincipalScore(d1Pos, d2Pos)
 *   - calculatePowerUnitScore(positions[])
 *
 * Run dry-run first:  DRY_RUN=1 npx ts-node ...
 * Run live:           npx ts-node --project tsconfig.scripts.json -r tsconfig-paths/register --transpile-only scripts/backfill-2025-principal-pu.ts
 */

import 'dotenv/config';
import { connectDB } from '../lib/db';
import { HistoricalRaceBreakdown } from '../lib/models';
import { calculatePrincipalScore, calculatePowerUnitScore } from '../lib/otf-calculator';

const DRY_RUN      = process.env.DRY_RUN === '1';
const START_ROUND: number = process.env.START_ROUND ? parseInt(process.env.START_ROUND, 10) : 1;

// ---------------------------------------------------------------------------
// 2025 race calendar (OpenF1 meeting_key → round metadata)
// ---------------------------------------------------------------------------
const RACES_2025 = [
  { round: 1,  meetingKey: 1254, shortName: 'Australia',      flag: '🇦🇺' },
  { round: 2,  meetingKey: 1255, shortName: 'China',          flag: '🇨🇳' },
  { round: 3,  meetingKey: 1256, shortName: 'Japan',          flag: '🇯🇵' },
  { round: 4,  meetingKey: 1257, shortName: 'Bahrain',        flag: '🇧🇭' },
  { round: 5,  meetingKey: 1258, shortName: 'Saudi Arabia',   flag: '🇸🇦' },
  { round: 6,  meetingKey: 1259, shortName: 'Miami',          flag: '🇺🇸' },
  { round: 7,  meetingKey: 1260, shortName: 'Emilia Romagna', flag: '🇮🇹' },
  { round: 8,  meetingKey: 1261, shortName: 'Monaco',         flag: '🇲🇨' },
  { round: 9,  meetingKey: 1262, shortName: 'Spain',          flag: '🇪🇸' },
  { round: 10, meetingKey: 1263, shortName: 'Canada',         flag: '🇨🇦' },
  { round: 11, meetingKey: 1264, shortName: 'Austria',        flag: '🇦🇹' },
  { round: 12, meetingKey: 1277, shortName: 'Great Britain',  flag: '🇬🇧' },
  { round: 13, meetingKey: 1265, shortName: 'Belgium',        flag: '🇧🇪' },
  { round: 14, meetingKey: 1266, shortName: 'Hungary',        flag: '🇭🇺' },
  { round: 15, meetingKey: 1267, shortName: 'Netherlands',    flag: '🇳🇱' },
  { round: 16, meetingKey: 1268, shortName: 'Italy',          flag: '🇮🇹' },
  { round: 17, meetingKey: 1269, shortName: 'Azerbaijan',     flag: '🇦🇿' },
  { round: 18, meetingKey: 1270, shortName: 'Singapore',      flag: '🇸🇬' },
  { round: 19, meetingKey: 1271, shortName: 'United States',  flag: '🇺🇸' },
  { round: 20, meetingKey: 1272, shortName: 'Mexico City',    flag: '🇲🇽' },
  { round: 21, meetingKey: 1273, shortName: 'São Paulo',      flag: '🇧🇷' },
  { round: 22, meetingKey: 1274, shortName: 'Las Vegas',      flag: '🇺🇸' },
  { round: 23, meetingKey: 1275, shortName: 'Qatar',          flag: '🇶🇦' },
  { round: 24, meetingKey: 1276, shortName: 'Abu Dhabi',      flag: '🇦🇪' },
];

// ---------------------------------------------------------------------------
// Team → asset slug mappings for 2025
// OpenF1 team_name normalised to our slugs.
// ---------------------------------------------------------------------------

/** Principal slug per OpenF1 team name */
const TEAM_TO_PRINCIPAL: Record<string, string> = {
  'Red Bull Racing': 'christian-horner',
  'McLaren':         'zak-brown',
  'Ferrari':         'frederic-vasseur',
  'Mercedes':        'toto-wolff',
  'Aston Martin':    'mike-krack',
  'Alpine':          'oliver-oakes',
  'Williams':        'james-vowles',
  'Haas F1 Team':    'ayao-komatsu',
  'Kick Sauber':     'mattia-binotto',
  // Racing Bulls had no named principal tracked in 2025 HistoricalSeason
};

/**
 * Per-team PU slugs tracked in 2025 HistoricalSeason.
 * NOTE: Mercedes, Ferrari, McLaren teams are NOT listed separately as per-team PUs
 * in 2025 — they are only covered by the engine-manufacturer groups below.
 * Racing Bulls also has no per-team PU entry in 2025 HistoricalSeason.
 */
const TEAM_TO_PU_SLUG: Record<string, string> = {
  'Red Bull Racing': 'red-bull-pu',
  'Aston Martin':    'aston-martin-pu',
  'Williams':        'williams-pu',
  'Haas F1 Team':    'haas-pu',
  'Kick Sauber':     'sauber-pu',
  'Alpine':          'alpine-pu',
};

/**
 * Engine-manufacturer PU slugs and which OpenF1 teams use each engine.
 * honda-rbpt = Red Bull + Racing Bulls + Aston Martin
 * mercedes   = Mercedes + McLaren + Williams
 * ferrari    = Ferrari + Haas + Kick Sauber
 * renault    = Alpine
 */
const ENGINE_PU_GROUPS: Array<{ slug: string; teams: string[] }> = [
  {
    slug:  'honda-rbpt-pu',
    teams: ['Red Bull Racing', 'Racing Bulls', 'Aston Martin'],
  },
  {
    slug:  'mercedes-pu',
    teams: ['Mercedes', 'McLaren', 'Williams'],
  },
  {
    slug:  'ferrari-pu',
    teams: ['Ferrari', 'Haas F1 Team', 'Kick Sauber'],
  },
  {
    slug:  'renault-pu',
    teams: ['Alpine'],
  },
];

// ---------------------------------------------------------------------------
// OpenF1 helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url: string, retries = 6): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      const wait = 3000 + 3000 * attempt;
      console.warn(`  429 rate limit (attempt ${attempt + 1}), waiting ${wait}ms…`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`OpenF1 ${res.status}: ${url}`);
    return res.json();
  }
  throw new Error(`OpenF1 persistently rate-limited: ${url}`);
}

async function getRaceSessionKey(meetingKey: number): Promise<number | null> {
  const data = await fetchJson(
    `https://api.openf1.org/v1/sessions?meeting_key=${meetingKey}&session_name=Race`,
  );
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0].session_key;
}

interface DriverInfo {
  driverNumber: number;
  acronym: string;
  teamName: string;
  lastName: string;
}

async function getDrivers(sessionKey: number): Promise<DriverInfo[]> {
  const data = await fetchJson(
    `https://api.openf1.org/v1/drivers?session_key=${sessionKey}`,
  );
  return data.map((d: any) => ({
    driverNumber: d.driver_number,
    acronym:      d.name_acronym ?? '',
    teamName:     d.team_name ?? '',
    lastName:     d.last_name ?? d.name_acronym ?? '',
  }));
}

interface PositionEntry {
  driverNumber: number;
  position: number;
  date: string;
}

async function getFinalPositions(sessionKey: number): Promise<Map<number, number>> {
  const data = await fetchJson(
    `https://api.openf1.org/v1/position?session_key=${sessionKey}`,
  );
  // Each entry: { driver_number, position, date }
  // Use the LAST recorded position per driver (= final finishing position).
  const latest = new Map<number, PositionEntry>();
  for (const entry of data) {
    const existing = latest.get(entry.driver_number);
    if (!existing || entry.date > existing.date) {
      latest.set(entry.driver_number, {
        driverNumber: entry.driver_number,
        position:     entry.position,
        date:         entry.date,
      });
    }
  }
  const result = new Map<number, number>();
  for (const [dn, entry] of latest) {
    result.set(dn, entry.position);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await connectDB();

  let totalInserted = 0;
  const docs: any[] = [];

  for (const race of RACES_2025.filter(r => r.round >= START_ROUND)) {
    console.log(`\nR${race.round} ${race.shortName} (meeting ${race.meetingKey})...`);

    const sessionKey = await getRaceSessionKey(race.meetingKey);
    if (!sessionKey) {
      console.warn(`  ⚠ No race session found for meeting ${race.meetingKey}, skipping.`);
      continue;
    }

    const [drivers, positions] = await Promise.all([
      getDrivers(sessionKey),
      getFinalPositions(sessionKey),
    ]);

    // Build team → [{driverNumber, position, lastName}]
    const teamMap = new Map<string, Array<{ dn: number; pos: number; lastName: string }>>();
    for (const driver of drivers) {
      const pos = positions.get(driver.driverNumber);
      if (pos === undefined) {
        console.warn(`  ⚠ No position for driver #${driver.driverNumber} ${driver.acronym}`);
        continue;
      }
      if (!teamMap.has(driver.teamName)) teamMap.set(driver.teamName, []);
      teamMap.get(driver.teamName)!.push({ dn: driver.driverNumber, pos, lastName: driver.lastName });
    }

    // Print team grid for verification
    for (const [team, cars] of teamMap) {
      const carStr = cars.map(c => `P${c.pos}(#${c.dn})`).join(' ');
      console.log(`  ${team.padEnd(20)} ${carStr}`);
    }

    const base = { season: 2025, round: race.round, shortName: race.shortName, flag: race.flag,
                   btBonus: 0, flBonus: 0, pgScore: 0, dnf: false };

    // --- Principals ---
    for (const [teamName, principalSlug] of Object.entries(TEAM_TO_PRINCIPAL)) {
      const cars = teamMap.get(teamName);
      if (!cars || cars.length < 1) {
        console.warn(`  ⚠ No cars found for principal ${principalSlug} (${teamName})`);
        continue;
      }
      // Sort by position to assign driver1/driver2
      const sorted = [...cars].sort((a, b) => a.pos - b.pos);
      const d1 = sorted[0];
      const d2 = sorted[1];
      const rPts = calculatePrincipalScore(d1.pos, d2?.pos ?? 25);

      docs.push({
        ...base,
        assetSlug:  principalSlug,
        assetType:  'principal',
        driver1Pos:  d1.pos,
        driver1Name: d1.lastName,
        driver2Pos:  d2?.pos ?? null,
        driver2Name: d2?.lastName ?? null,
        rPts,
        tot: rPts,
      });
    }

    // --- Per-team PUs ---
    for (const [teamName, puSlug] of Object.entries(TEAM_TO_PU_SLUG)) {
      const cars = teamMap.get(teamName);
      if (!cars || cars.length < 1) {
        console.warn(`  ⚠ No cars found for PU ${puSlug} (${teamName})`);
        continue;
      }
      const carPositions = cars.map(c => c.pos);
      const rPts = calculatePowerUnitScore(carPositions);

      docs.push({
        ...base,
        assetSlug:    puSlug,
        assetType:    'powerUnit',
        carPositions,
        rPts,
        tot: rPts,
      });
    }

    // --- Engine-manufacturer PUs ---
    for (const group of ENGINE_PU_GROUPS) {
      const allPositions: number[] = [];
      for (const teamName of group.teams) {
        const cars = teamMap.get(teamName);
        if (cars) allPositions.push(...cars.map(c => c.pos));
      }
      if (allPositions.length === 0) {
        console.warn(`  ⚠ No cars found for engine PU ${group.slug}`);
        continue;
      }
      const rPts = calculatePowerUnitScore(allPositions);

      docs.push({
        ...base,
        assetSlug:    group.slug,
        assetType:    'powerUnit',
        carPositions: allPositions,
        rPts,
        tot: rPts,
      });
    }

    // Polite delay between rounds to avoid OpenF1 rate limiting
    await sleep(3000);
  }

  console.log(`\n--- Summary ---`);
  console.log(`Docs to insert: ${docs.length}`);

  if (DRY_RUN) {
    console.log('DRY RUN — no writes. Sample docs:');
    docs.slice(0, 4).forEach(d => console.log(JSON.stringify(d)));
  } else {
    // Delete any existing 2025 principal/PU HRB docs before re-inserting
    const deleted = await HistoricalRaceBreakdown.deleteMany({
      season: 2025,
      assetType: { $in: ['principal', 'powerUnit'] },
    });
    console.log(`Deleted ${deleted.deletedCount} existing 2025 principal/PU HRB docs.`);

    await HistoricalRaceBreakdown.insertMany(docs);
    totalInserted = docs.length;
    console.log(`Inserted ${totalInserted} docs.`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
