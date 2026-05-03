/**
 * backfill-miami-results.ts
 *
 * One-off backfill: reconstructs and writes the per-asset race-day result arrays
 * to the Miami 2026 RaceCalendar document (round 6, meetingKey 1284).
 *
 * What this does:
 *   - Fetches Miami race weekend data from OpenF1
 *   - Runs the same scoring functions as processRace()
 *   - Writes ONLY to RaceCalendar: raceResults / principalResults / pitCrewResults / powerUnitResults
 *
 * What this does NOT do:
 *   - Does NOT call processRace()
 *   - Does NOT modify Roster.totalPoints
 *   - Does NOT modify Asset.totalPoints
 *   - Does NOT modify ProcessedRace
 *
 * Run with:
 *   node_modules/.bin/ts-node \
 *     --project tsconfig.scripts.json \
 *     --compiler-options '{"module":"commonjs"}' \
 *     scripts/backfill-miami-results.ts
 */

import mongoose from 'mongoose';
import { buildRaceWeekendData } from '../lib/scoring/openf1';
import { calculateRaceWeekendScores } from '../lib/scoring/index';
import { Asset, RaceCalendar } from '../lib/models';
import { connectDB } from '../lib/db';

// Same map as process-race-logic.ts — must stay in sync
const POWER_UNIT_MAP: Record<string, string> = {
  'Red Bull Racing': 'Ford Red Bull Powertrains',
  'Racing Bulls':    'Ford Red Bull Powertrains',
  'Cadillac':        'General Motors',
  'Mercedes':        'Mercedes',
  'McLaren':         'Mercedes',
  'Williams':        'Mercedes',
  'Ferrari':         'Ferrari',
  'Haas':            'Ferrari',
  'Aston Martin':    'Honda',
  'Alpine':          'Renault',
  'Audi':            'Audi',
};

// Same helper as process-race-logic.ts
function pitCrewCarNumber(slug: string): number {
  const m = slug.match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

const MIAMI_MEETING_KEY = 1284;
const MIAMI_ROUND = 6;

async function main() {
  await connectDB();

  // ── 1. Verify Miami calendar doc ──────────────────────────────────────────
  const calendar = await RaceCalendar.findOne({ season: 2026, round: MIAMI_ROUND }).lean() as any;
  if (!calendar) throw new Error('Miami RaceCalendar not found');
  console.log(`Found calendar: ${calendar.name} (round ${calendar.round}, meetingKey ${calendar.meetingKey})`);
  console.log(`  processed: ${calendar.processed}`);
  console.log(`  Existing raceResults count: ${(calendar.raceResults ?? []).length}`);

  // ── 2. Fetch weekend data from OpenF1 (same call as processRace) ──────────
  console.log('\nFetching OpenF1 data for meetingKey', MIAMI_MEETING_KEY, '...');
  const weekendData = await buildRaceWeekendData(MIAMI_MEETING_KEY, POWER_UNIT_MAP);
  console.log(`  raceName: ${weekendData.raceName}`);
  console.log(`  raceResults from OpenF1: ${weekendData.raceResults.length} drivers`);
  console.log(`  principalResults: ${weekendData.principalResults.length} teams`);
  console.log(`  pitData: ${weekendData.pitData.length} cars`);
  console.log(`  carFinishData: ${weekendData.carFinishData.length} cars`);

  // ── 3. Load principal streak states (same as processRace step 2) ──────────
  const principalAssets = await Asset.find({ season: 2026, assetType: 'principal', isActive: true }).lean() as any[];
  const streakStates: Record<string, { qualifyingStreak: number; raceStreak: number }> = {};
  for (const pa of principalAssets) {
    streakStates[pa.team ?? pa.teamSlug] = {
      qualifyingStreak: pa.qualifyingStreak ?? 0,
      raceStreak:       pa.raceStreak ?? 0,
    };
  }

  // ── 4. Run same scoring functions as processRace ──────────────────────────
  const { scores } = calculateRaceWeekendScores(weekendData, streakStates);
  console.log(`\nScores computed:`);
  console.log(`  race drivers: ${scores.race.length}`);
  console.log(`  principals:   ${scores.principals.length}`);
  console.log(`  pitCrews:     ${scores.pitCrews.length}`);
  console.log(`  powerUnits:   ${scores.powerUnits.length}`);

  // ── 5. Load all 2026 assets for slug lookups (same as processRace step 5) ─
  const allAssets = await Asset.find({ season: 2026, isActive: true }).lean() as any[];

  const driverSlugByCarNum  = new Map<number, string>();
  const principalSlugByTeam = new Map<string, string>();
  const pitCrewSlugByCarNum = new Map<number, string>();

  for (const a of allAssets) {
    if (a.assetType === 'driver' && a.carNumber)   driverSlugByCarNum.set(a.carNumber, a.slug);
    if (a.assetType === 'principal' && a.team)     principalSlugByTeam.set(a.team, a.slug);
    if (a.assetType === 'pitCrew') {
      const cn = a.carNumber ?? pitCrewCarNumber(a.slug ?? '');
      if (cn) pitCrewSlugByCarNum.set(cn, a.slug);
    }
  }

  // Power units: manufacturer → points (multiple assets can share a manufacturer)
  const puPointsByManufacturer = new Map<string, number>();
  for (const p of scores.powerUnits) {
    puPointsByManufacturer.set(p.manufacturer, Math.round(p.points * 100) / 100);
  }

  // ── 6. Build result arrays (exact same logic as processRace Step 9) ────────
  const raceScoreByNum = new Map<number, number>(scores.race.map(r => [r.driverNumber, r.total]));

  const raceResultsForCal = weekendData.raceResults
    .filter(r => driverSlugByCarNum.has(r.driverNumber))
    .map(r => ({
      driverSlug:    driverSlugByCarNum.get(r.driverNumber)!,
      position:      r.finishPosition ?? null,
      startPosition: r.startPosition,
      points:        Math.round((raceScoreByNum.get(r.driverNumber) ?? 0) * 100) / 100,
      fastestLap:    r.fastestLap,
      notClassified: r.status === 'DNF',
      dsq:           r.status === 'DSQ',
    }))
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));

  const principalResultsForCal = scores.principals
    .filter(p => principalSlugByTeam.has(p.teamName))
    .map(p => ({
      principalSlug: principalSlugByTeam.get(p.teamName)!,
      points:        Math.round(p.total * 100) / 100,
    }));

  const pitCrewResultsForCal = scores.pitCrews
    .filter(p => pitCrewSlugByCarNum.has(p.carNumber))
    .map(p => ({
      pitCrewSlug: pitCrewSlugByCarNum.get(p.carNumber)!,
      points:      Math.round(p.total * 100) / 100,
    }));

  // One entry per PU asset — assets sharing a manufacturer all get the same manufacturer score
  const powerUnitResultsForCal = allAssets
    .filter(a => a.assetType === 'powerUnit' && a.manufacturer && puPointsByManufacturer.has(a.manufacturer))
    .map(a => ({
      powerUnitSlug: a.slug as string,
      points:        puPointsByManufacturer.get(a.manufacturer)!,
    }));

  // ── 7. Preview ─────────────────────────────────────────────────────────────
  console.log('\n=== PREVIEW — what will be written ===');

  console.log(`\nraceResults (${raceResultsForCal.length} drivers):`);
  raceResultsForCal.slice(0, 5).forEach(r =>
    console.log(`  P${r.position ?? 'NC'} ${r.driverSlug.padEnd(25)} pts=${r.points}  fl=${r.fastestLap}  nc=${r.notClassified}  dsq=${r.dsq}`)
  );
  const racePtsSum = raceResultsForCal.reduce((s, r) => s + r.points, 0);
  console.log(`  ... total across all drivers: ${Math.round(racePtsSum * 100) / 100} pts`);

  console.log(`\nprincipalResults (${principalResultsForCal.length} principals):`);
  principalResultsForCal.sort((a, b) => b.points - a.points).forEach(r =>
    console.log(`  ${r.principalSlug.padEnd(30)} pts=${r.points}`)
  );

  console.log(`\npitCrewResults (${pitCrewResultsForCal.length} pit crews):`);
  pitCrewResultsForCal.sort((a, b) => b.points - a.points).slice(0, 5).forEach(r =>
    console.log(`  ${r.pitCrewSlug.padEnd(30)} pts=${r.points}`)
  );

  console.log(`\npowerUnitResults (${powerUnitResultsForCal.length} power units):`);
  powerUnitResultsForCal.sort((a, b) => b.points - a.points).forEach(r =>
    console.log(`  ${r.powerUnitSlug.padEnd(30)} pts=${r.points}`)
  );

  // ── 8. Prompt before writing ────────────────────────────────────────────────
  // (In a real interactive environment you'd pause here — for now the script
  //  writes automatically. Pass --dry-run to skip the write.)
  const isDryRun = process.argv.includes('--dry-run');
  if (isDryRun) {
    console.log('\n[DRY RUN] Skipping DB write. Pass no flags to apply.');
    await mongoose.disconnect();
    return;
  }

  // ── 9. Write ONLY to RaceCalendar ─────────────────────────────────────────
  console.log('\nWriting to RaceCalendar...');
  await RaceCalendar.findOneAndUpdate(
    { _id: calendar._id },
    { $set: {
        raceResults:      raceResultsForCal,
        principalResults: principalResultsForCal,
        pitCrewResults:   pitCrewResultsForCal,
        powerUnitResults: powerUnitResultsForCal,
      },
    },
  );

  // Verify
  const after = await RaceCalendar.findOne({ season: 2026, round: MIAMI_ROUND }).lean() as any;
  console.log('\n=== VERIFICATION ===');
  console.log(`raceResults written:      ${(after.raceResults ?? []).length}`);
  console.log(`principalResults written: ${(after.principalResults ?? []).length}`);
  console.log(`pitCrewResults written:   ${(after.pitCrewResults ?? []).length}`);
  console.log(`powerUnitResults written: ${(after.powerUnitResults ?? []).length}`);
  console.log('\nDone. Roster.totalPoints and Asset.totalPoints were NOT modified.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
