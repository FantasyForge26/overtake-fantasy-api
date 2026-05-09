/**
 * backfill-2026-r1-r3-results.ts
 *
 * Backfills RaceCalendar result arrays for R1 (Australia, meetingKey 1279),
 * R2 (China, meetingKey 1280), and R3 (Japan, meetingKey 1281).
 *
 * These rounds were processed before the per-array storage pattern existed.
 * Asset.totalPoints / Roster.totalPoints are already correct — this script
 * ONLY writes the display arrays used by the season-breakdown and asset-card
 * endpoints.
 *
 * What this writes to each RaceCalendar doc:
 *   qualifyingResults, raceResults, principalResults, pitCrewResults, powerUnitResults
 *   + sprintQualiResults, sprintRaceResults for R2 (China sprint weekend)
 *
 * What this does NOT touch:
 *   Asset.totalPoints / racesCompleted / avgPointsPerRace
 *   Roster.totalPoints / seasonRank
 *   ProcessedRace
 *   ScoringLog
 *
 * Idempotency: sets r1r3ResultsBackfilled: true on each calendar doc.
 *   Re-running skips already-done rounds but still scores them to chain
 *   streak states correctly into subsequent rounds.
 *
 * Usage:
 *   DRY_RUN=1 npx ts-node --project tsconfig.scripts.json \
 *     -r tsconfig-paths/register --transpile-only \
 *     scripts/backfill-2026-r1-r3-results.ts
 *
 *   # live:
 *   npx ts-node --project tsconfig.scripts.json \
 *     -r tsconfig-paths/register --transpile-only \
 *     scripts/backfill-2026-r1-r3-results.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { buildRaceWeekendData } from '../lib/scoring/openf1';
import { calculateRaceWeekendScores, PrincipalStreakState } from '../lib/scoring/index';
import { POWER_UNIT_MAP } from '../lib/scoring/process-race-logic';
import { Asset, RaceCalendar } from '../lib/models';
import { connectDB } from '../lib/db';

const DRY_RUN = process.env.DRY_RUN === '1';

// ---------------------------------------------------------------------------
// Round definitions
// ---------------------------------------------------------------------------

const ROUNDS = [
  { round: 1, meetingKey: 1279, name: 'Australian Grand Prix', isSprint: false },
  { round: 2, meetingKey: 1280, name: 'Chinese Grand Prix',    isSprint: true  },
  { round: 3, meetingKey: 1281, name: 'Japanese Grand Prix',   isSprint: false },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pitCrewCarNumber(slug: string): number {
  const m = slug.match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

interface SlugMaps {
  driverSlugByCarNum:   Map<number, string>;
  principalSlugByTeam:  Map<string, string>;
  pitCrewSlugByCarNum:  Map<number, string>;
  /** manufacturer → all PU asset slugs that use it */
  puSlugsByManufacturer: Map<string, string[]>;
}

async function buildSlugMaps(): Promise<SlugMaps> {
  const allAssets = await Asset.find({ season: 2026, isActive: true }).lean() as any[];

  const driverSlugByCarNum   = new Map<number, string>();
  const principalSlugByTeam  = new Map<string, string>();
  const pitCrewSlugByCarNum  = new Map<number, string>();
  const puSlugsByManufacturer = new Map<string, string[]>();

  for (const a of allAssets) {
    if (a.assetType === 'driver' && a.carNumber) {
      driverSlugByCarNum.set(a.carNumber, a.slug);
    }
    if (a.assetType === 'principal' && a.team) {
      principalSlugByTeam.set(a.team, a.slug);
    }
    if (a.assetType === 'pitCrew') {
      const cn = a.carNumber ?? pitCrewCarNumber(a.slug ?? '');
      if (cn) pitCrewSlugByCarNum.set(cn, a.slug);
    }
    if (a.assetType === 'powerUnit' && a.manufacturer) {
      const arr = puSlugsByManufacturer.get(a.manufacturer) ?? [];
      arr.push(a.slug);
      puSlugsByManufacturer.set(a.manufacturer, arr);
    }
  }

  console.log(`Slug maps built from ${allAssets.length} 2026 active assets:`);
  console.log(`  drivers: ${driverSlugByCarNum.size}, principals: ${principalSlugByTeam.size}`);
  console.log(`  pitCrews: ${pitCrewSlugByCarNum.size}, PU manufacturers: ${puSlugsByManufacturer.size}`);

  return { driverSlugByCarNum, principalSlugByTeam, pitCrewSlugByCarNum, puSlugsByManufacturer };
}

// ---------------------------------------------------------------------------
// Per-round processing
// ---------------------------------------------------------------------------

async function processRound(
  round: number,
  meetingKey: number,
  name: string,
  isSprint: boolean,
  streakStates: Record<string, PrincipalStreakState>,
  maps: SlugMaps,
): Promise<Record<string, PrincipalStreakState>> {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`R${round} ${name}  (meetingKey=${meetingKey}, isSprint=${isSprint})`);
  console.log('─'.repeat(60));

  const calendar = await RaceCalendar.findOne({ season: 2026, round }).lean() as any;
  if (!calendar) throw new Error(`RaceCalendar not found for season 2026 round ${round}`);

  const alreadyDone = !!calendar.r1r3ResultsBackfilled;
  if (alreadyDone) {
    console.log('  ⚠ Already backfilled — will score for streak chaining but skip write.');
  }

  // --- Fetch from OpenF1 ---
  console.log('  Fetching from OpenF1...');
  const weekendData = await buildRaceWeekendData(meetingKey, POWER_UNIT_MAP);
  console.log(`  Sessions: race=${weekendData.raceResults.length} drivers, quali=${weekendData.qualifyingResults.length} drivers`);
  if (isSprint) {
    console.log(`  Sprint: qualiResults=${weekendData.sprintQualiResults?.length ?? 0}, raceResults=${weekendData.sprintResults?.length ?? 0}`);
  }

  // --- Score ---
  const { scores, newPrincipalStreakStates } = calculateRaceWeekendScores(weekendData, streakStates);

  // --- Build qualifying results ---
  const qualScoreByNum = new Map(scores.qualifying.map(q => [q.driverNumber, q.total]));
  const qualifyingResultsForCal = weekendData.qualifyingResults
    .filter(q => maps.driverSlugByCarNum.has(q.driverNumber))
    .map(q => ({
      driverSlug: maps.driverSlugByCarNum.get(q.driverNumber)!,
      position:   q.finalPosition ?? null,
      stage:      (q.finalPosition ?? 99) <= 10 ? 'Q3' : (q.finalPosition ?? 99) <= 15 ? 'Q2' : 'Q1',
      points:     Math.round((qualScoreByNum.get(q.driverNumber) ?? 0) * 100) / 100,
      fastestLap: false,
    }))
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));

  // --- Build race results ---
  const raceScoreByNum = new Map(scores.race.map(r => [r.driverNumber, r.total]));
  const raceResultsForCal = weekendData.raceResults
    .filter(r => maps.driverSlugByCarNum.has(r.driverNumber))
    .map(r => ({
      driverSlug:    maps.driverSlugByCarNum.get(r.driverNumber)!,
      position:      r.finishPosition ?? null,
      startPosition: r.startPosition,
      points:        Math.round((raceScoreByNum.get(r.driverNumber) ?? 0) * 100) / 100,
      fastestLap:    r.fastestLap,
      notClassified: r.status === 'DNF',
      dsq:           r.status === 'DSQ',
    }))
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));

  // --- Sprint qualifying results (R2 only) ---
  let sprintQualiResultsForCal: any[] | undefined;
  if (isSprint && weekendData.sprintQualiResults && scores.sprintQuali) {
    const sqScoreByNum = new Map(scores.sprintQuali.map(s => [s.driverNumber, s.total]));
    sprintQualiResultsForCal = weekendData.sprintQualiResults
      .filter(sq => maps.driverSlugByCarNum.has(sq.driverNumber))
      .map(sq => ({
        driverSlug: maps.driverSlugByCarNum.get(sq.driverNumber)!,
        position:   sq.position,
        points:     Math.round((sqScoreByNum.get(sq.driverNumber) ?? 0) * 100) / 100,
      }))
      .sort((a, b) => a.position - b.position);
  }

  // --- Sprint race results (R2 only) ---
  // Note: fastestLap is not detected by scoring functions for sprint;
  // set to false (cosmetic only — sprint FL has no scoring effect).
  let sprintRaceResultsForCal: any[] | undefined;
  if (isSprint && weekendData.sprintResults && scores.sprint) {
    const sprintScoreByNum = new Map(scores.sprint.map(s => [s.driverNumber, s.total]));
    sprintRaceResultsForCal = weekendData.sprintResults
      .filter(s => maps.driverSlugByCarNum.has(s.driverNumber))
      .map(s => ({
        driverSlug:    maps.driverSlugByCarNum.get(s.driverNumber)!,
        position:      s.finishPosition ?? null,
        startPosition: s.startPosition,
        points:        Math.round((sprintScoreByNum.get(s.driverNumber) ?? 0) * 100) / 100,
        fastestLap:    false,
      }))
      .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  }

  // --- Principal results ---
  const principalResultsForCal = scores.principals
    .filter(p => maps.principalSlugByTeam.has(p.teamName))
    .map(p => ({
      principalSlug: maps.principalSlugByTeam.get(p.teamName)!,
      points:        Math.round(p.total * 100) / 100,
    }))
    .sort((a, b) => b.points - a.points);

  // --- Pit crew results ---
  const pitCrewResultsForCal = scores.pitCrews
    .filter(p => maps.pitCrewSlugByCarNum.has(p.carNumber))
    .map(p => ({
      pitCrewSlug: maps.pitCrewSlugByCarNum.get(p.carNumber)!,
      points:      Math.round(p.total * 100) / 100,
    }))
    .sort((a, b) => b.points - a.points);

  // --- Power unit results (one entry per PU asset slug) ---
  const puPointsByManufacturer = new Map(
    scores.powerUnits.map(p => [p.manufacturer, Math.round(p.points * 100) / 100]),
  );
  const powerUnitResultsForCal: Array<{ powerUnitSlug: string; points: number }> = [];
  for (const [manufacturer, slugs] of maps.puSlugsByManufacturer) {
    const pts = puPointsByManufacturer.get(manufacturer);
    if (pts === undefined) {
      console.warn(`  ⚠ No power unit score found for manufacturer "${manufacturer}" — check POWER_UNIT_MAP`);
      continue;
    }
    for (const slug of slugs) {
      powerUnitResultsForCal.push({ powerUnitSlug: slug, points: pts });
    }
  }

  // --- Preview ---
  console.log(`\n  qualifyingResults:  ${qualifyingResultsForCal.length} entries`);
  console.log(`  raceResults:        ${raceResultsForCal.length} entries`);
  if (sprintQualiResultsForCal) console.log(`  sprintQualiResults: ${sprintQualiResultsForCal.length} entries`);
  if (sprintRaceResultsForCal)  console.log(`  sprintRaceResults:  ${sprintRaceResultsForCal.length} entries`);
  console.log(`  principalResults:   ${principalResultsForCal.length} entries`);
  console.log(`  pitCrewResults:     ${pitCrewResultsForCal.length} entries`);
  console.log(`  powerUnitResults:   ${powerUnitResultsForCal.length} entries`);

  console.log('  Race top 5:');
  raceResultsForCal.slice(0, 5).forEach(r =>
    console.log(`    P${String(r.position ?? 'NC').padStart(2)} ${r.driverSlug.padEnd(28)} pts=${r.points}  fl=${r.fastestLap}  nc=${r.notClassified}`),
  );

  console.log('  Qualifying top 5:');
  qualifyingResultsForCal.slice(0, 5).forEach(q =>
    console.log(`    P${String(q.position ?? '?').padStart(2)} ${q.driverSlug.padEnd(28)} pts=${q.points}  stage=${q.stage}`),
  );

  console.log('  Principals:');
  principalResultsForCal.forEach(p =>
    console.log(`    ${p.principalSlug.padEnd(30)} pts=${p.points}`),
  );

  console.log('  Power units:');
  powerUnitResultsForCal
    .sort((a, b) => b.points - a.points)
    .forEach(p => console.log(`    ${p.powerUnitSlug.padEnd(28)} pts=${p.points}`));

  // --- Write (unless dry run or already done) ---
  if (DRY_RUN) {
    console.log('\n  [DRY RUN] Skipping write.');
  } else if (alreadyDone) {
    console.log('\n  Already backfilled — skipping write.');
  } else {
    const update: Record<string, any> = {
      qualifyingResults:     qualifyingResultsForCal,
      raceResults:           raceResultsForCal,
      principalResults:      principalResultsForCal,
      pitCrewResults:        pitCrewResultsForCal,
      powerUnitResults:      powerUnitResultsForCal,
      r1r3ResultsBackfilled: true,
    };
    if (sprintQualiResultsForCal !== undefined) update.sprintQualiResults = sprintQualiResultsForCal;
    if (sprintRaceResultsForCal  !== undefined) update.sprintRaceResults  = sprintRaceResultsForCal;

    await RaceCalendar.findOneAndUpdate(
      { season: 2026, round },
      { $set: update },
    );
    console.log('\n  ✓ Written to RaceCalendar (r1r3ResultsBackfilled: true).');
  }

  return newPrincipalStreakStates;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`=== backfill-2026-r1-r3-results ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);

  await connectDB();

  const maps = await buildSlugMaps();

  // R1 starts with all-zero streak states; R2 and R3 chain from prior output.
  let streakStates: Record<string, PrincipalStreakState> = {};

  for (const { round, meetingKey, name, isSprint } of ROUNDS) {
    streakStates = await processRound(round, meetingKey, name, isSprint, streakStates, maps);
  }

  console.log('\n=== Done ===');
  if (DRY_RUN) console.log('DRY RUN complete — no writes made.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
