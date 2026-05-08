/**
 * backfill-miami-boosts.ts
 *
 * One-off backfill: applies the 2x boost for Miami 2026 (round 6) retroactively.
 *
 * What this does:
 *   1. Optionally initializes boostsRemaining=6 on all 2026 driver + pitCrew assets
 *      (12 max − 6 prior rounds: AUS, CHN, JPN, BHR, SAU, MIA)
 *      Skip with --skip-init if already done.
 *   2. For every 2026 roster that has both driver1AssetId AND pitCrew1AssetId:
 *      - Computes d1Delta = sum of all session base points for Driver 1 (sprint quali + sprint race + main quali + race)
 *      - Computes pc1Delta = pit crew 1's race-day base points
 *      - $inc Roster.totalPoints by (d1Delta + pc1Delta)
 *      - $inc Asset.boostsRemaining by -1 for Driver 1 and Pit Crew 1
 *   3. Sets miamiBoostBackfilled=true on the Miami RaceCalendar doc (idempotency guard).
 *
 * What this does NOT do:
 *   - Does NOT modify Asset.totalPoints
 *   - Does NOT modify RaceCalendar result arrays
 *   - Does NOT modify any Roster fields other than totalPoints
 *   - Refuses to run twice (miamiBoostBackfilled idempotency flag)
 *
 * Run:
 *   # Dry run (no writes):
 *   MONGODB_URI=... node_modules/.bin/ts-node --project tsconfig.scripts.json \
 *     -r tsconfig-paths/register --transpile-only \
 *     scripts/backfill-miami-boosts.ts --dry-run
 *
 *   # Apply (also initializes counters):
 *   MONGODB_URI=... node_modules/.bin/ts-node --project tsconfig.scripts.json \
 *     -r tsconfig-paths/register --transpile-only \
 *     scripts/backfill-miami-boosts.ts
 *
 *   # Apply without re-initializing counters:
 *   ... scripts/backfill-miami-boosts.ts --skip-init
 */

import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import { Asset, League, Roster, RaceCalendar } from '../lib/models';

const MIAMI_ROUND  = 6;
const MIAMI_SEASON = 2026;
const BOOSTS_REMAINING_INITIAL = 6; // 12 max − 6 completed rounds
const TEST_LEAGUE_INVITE_CODE  = '9E3SHR'; // scope boost application to test league only

const isDryRun  = process.argv.includes('--dry-run');
const skipInit  = process.argv.includes('--skip-init');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSlugMap(arr: any[], slugField: string, ptsField = 'points'): Map<string, number> {
  const m = new Map<string, number>();
  if (!Array.isArray(arr)) return m;
  for (const entry of arr) {
    if (entry[slugField]) m.set(entry[slugField], entry[ptsField] ?? 0);
  }
  return m;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await connectDB();

  // ── 0. Idempotency check ────────────────────────────────────────────────────
  const miami = await RaceCalendar.findOne({ season: MIAMI_SEASON, round: MIAMI_ROUND }).lean() as any;
  if (!miami) throw new Error('Miami RaceCalendar not found');

  if (miami.miamiBoostBackfilled === true) {
    console.log('❌ Already applied — miamiBoostBackfilled=true on RaceCalendar. Refusing to run again.');
    await mongoose.disconnect();
    process.exit(0);
  }
  console.log('✓ Idempotency check passed — miamiBoostBackfilled is not set.\n');

  // ── 1. Validate result arrays are populated ─────────────────────────────────
  const sqLen  = (miami.sprintQualiResults  ?? []).length;
  const srLen  = (miami.sprintRaceResults   ?? []).length;
  const qLen   = (miami.qualifyingResults   ?? []).length;
  const rLen   = (miami.raceResults         ?? []).length;
  const pcLen  = (miami.pitCrewResults      ?? []).length;

  console.log('=== Miami result arrays ===');
  console.log(`  sprintQualiResults: ${sqLen}`);
  console.log(`  sprintRaceResults:  ${srLen}`);
  console.log(`  qualifyingResults:  ${qLen}`);
  console.log(`  raceResults:        ${rLen}`);
  console.log(`  pitCrewResults:     ${pcLen}`);

  if (rLen === 0 || pcLen === 0) {
    throw new Error(
      'Miami raceResults or pitCrewResults are empty — run backfill-miami-results.ts first.'
    );
  }
  console.log('');

  // ── 2. Build slug → base points maps ───────────────────────────────────────
  const sqPts  = makeSlugMap(miami.sprintQualiResults,  'driverSlug');
  const srPts  = makeSlugMap(miami.sprintRaceResults,   'driverSlug');
  const qPts   = makeSlugMap(miami.qualifyingResults,   'driverSlug');
  const rPts   = makeSlugMap(miami.raceResults,         'driverSlug');
  const pcPts  = makeSlugMap(miami.pitCrewResults,      'pitCrewSlug');

  // ── 3. Initialize boostsRemaining on all 2026 driver + pitCrew assets ──────
  const initAssets = await Asset.find({
    season: MIAMI_SEASON,
    assetType: { $in: ['driver', 'pitCrew'] },
    isActive: true,
  }).lean() as any[];

  console.log(`=== Counter initialization (${skipInit ? 'SKIPPED via --skip-init' : `${initAssets.length} assets → boostsRemaining=6`}) ===`);
  if (!skipInit) {
    if (!isDryRun) {
      await Asset.updateMany(
        { season: MIAMI_SEASON, assetType: { $in: ['driver', 'pitCrew'] }, isActive: true },
        { $set: { boostsRemaining: BOOSTS_REMAINING_INITIAL } },
      );
    }
    console.log(`  ${isDryRun ? '[DRY RUN] Would set' : 'Set'} boostsRemaining=${BOOSTS_REMAINING_INITIAL} on ${initAssets.length} assets`);
  }
  console.log('');

  // ── 4. Scope to test league only ───────────────────────────────────────────
  const testLeague = await League.findOne({ inviteCode: TEST_LEAGUE_INVITE_CODE }).lean() as any;
  if (!testLeague) throw new Error(`Test league with invite code ${TEST_LEAGUE_INVITE_CODE} not found`);
  console.log(`=== Scope: test league "${testLeague.name}" (${testLeague._id}) ===\n`);

  // Load rosters in test league that have both d1 + pc1
  const rosters = await Roster.find({
    leagueId:        testLeague._id,
    season:          MIAMI_SEASON,
    driver1AssetId:  { $exists: true, $ne: null },
    pitCrew1AssetId: { $exists: true, $ne: null },
  }).lean() as any[];

  console.log(`=== Roster boost application (${rosters.length} test-league rosters with d1+pc1) ===`);

  // Load all assets in one query for lookups
  const allAssets = await Asset.find({ season: MIAMI_SEASON, isActive: true }).lean() as any[];
  const assetById = new Map<string, any>(allAssets.map(a => [a._id.toString(), a]));

  let totalBoostDelta = 0;
  let rostersAffected = 0;
  // Track unique asset IDs that get their counter decremented (one decrement per asset, not per roster)
  const boostedAssetIds = new Set<string>();
  const rosterLog: {
    leagueId: string; rosterId: string;
    d1Slug: string; d1Delta: number;
    pc1Slug: string; pc1Delta: number;
    totalDelta: number;
  }[] = [];

  for (const roster of rosters) {
    const d1  = assetById.get(roster.driver1AssetId.toString());
    const pc1 = assetById.get(roster.pitCrew1AssetId.toString());

    if (!d1 || !pc1) continue; // asset not found (inactive or missing)

    const d1Slug  = d1.slug as string;
    const pc1Slug = pc1.slug as string;

    // Driver delta = sum across all 4 sessions (base points — applying again gives 2x)
    const d1Delta = Math.round((
      (sqPts.get(d1Slug)  ?? 0) +
      (srPts.get(d1Slug)  ?? 0) +
      (qPts.get(d1Slug)   ?? 0) +
      (rPts.get(d1Slug)   ?? 0)
    ) * 100) / 100;

    // Pit crew delta = race-day only (pit crews don't score sprint/quali sessions)
    const pc1Delta = Math.round((pcPts.get(pc1Slug) ?? 0) * 100) / 100;

    const totalDelta = Math.round((d1Delta + pc1Delta) * 100) / 100;

    rosterLog.push({
      leagueId:   roster.leagueId.toString(),
      rosterId:   roster._id.toString(),
      d1Slug, d1Delta,
      pc1Slug, pc1Delta,
      totalDelta,
    });

    totalBoostDelta += totalDelta;
    rostersAffected++;

    // Track unique asset IDs for counter decrement
    boostedAssetIds.add(d1._id.toString());
    boostedAssetIds.add(pc1._id.toString());

    if (!isDryRun) {
      await Roster.findByIdAndUpdate(roster._id, {
        $inc: { totalPoints: totalDelta },
      });
    }
  }

  // Decrement boostsRemaining once per unique boosted asset (not once per roster)
  if (!isDryRun) {
    for (const assetId of boostedAssetIds) {
      await Asset.findByIdAndUpdate(assetId, { $inc: { boostsRemaining: -1 } });
    }
  }

  // ── 5. Print per-roster breakdown ──────────────────────────────────────────
  for (const entry of rosterLog) {
    const d1DeltaStr  = `d1=${entry.d1Slug.padEnd(28)} +${entry.d1Delta.toFixed(2)}`;
    const pc1DeltaStr = `pc1=${entry.pc1Slug.padEnd(28)} +${entry.pc1Delta.toFixed(2)}`;
    console.log(`  ${entry.rosterId.slice(-6)} | ${d1DeltaStr} | ${pc1DeltaStr} | TOTAL +${entry.totalDelta.toFixed(2)}`);
  }

  console.log('');
  console.log(`=== Summary ===`);
  console.log(`  League:             ${testLeague.name} (${TEST_LEAGUE_INVITE_CODE})`);
  console.log(`  Rosters affected:   ${rostersAffected}`);
  console.log(`  Unique assets with counter -1: ${boostedAssetIds.size}`);
  console.log(`  Total boost delta:  +${Math.round(totalBoostDelta * 100) / 100} pts across all rosters`);
  console.log(`  Mode:               ${isDryRun ? 'DRY RUN — no writes' : 'LIVE — writes committed'}`);

  // ── 6. Set idempotency flag ─────────────────────────────────────────────────
  if (!isDryRun) {
    await RaceCalendar.findOneAndUpdate(
      { season: MIAMI_SEASON, round: MIAMI_ROUND },
      { $set: { miamiBoostBackfilled: true } },
    );
    console.log('\n✓ miamiBoostBackfilled=true set on RaceCalendar.');
  } else {
    console.log('\n[DRY RUN] miamiBoostBackfilled flag would be set after live run.');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
