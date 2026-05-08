/**
 * backfill-miami-performance-selections.ts
 *
 * Phase 8F Part 1 — Creates retroactive PerformanceSelection docs for Miami round 6
 * in the Overtake Test League so that loadBoostedSlots() returns these boosts and
 * the weekend-scores endpoint can apply 2x to per-asset breakdowns.
 *
 * What this does:
 *   1. Refuses to run if miamiSelectionsBackfilled is true on Miami RaceCalendar.
 *   2. For each roster in the Overtake Test League (inviteCode 9E3SHR), season 2026:
 *      - Upserts a PerformanceSelection with:
 *          driver1Boost  = roster.driver1AssetId
 *          pitCrew1Boost = roster.pitCrew1AssetId
 *          locked        = true
 *          submittedAt   = now
 *          autoFilled    = false
 *      - Uses unique index (leagueId, userId, season, round) for upsert key.
 *   3. Sets miamiSelectionsBackfilled = true on RaceCalendar (idempotency).
 *
 * What this does NOT do:
 *   - Does NOT touch Asset, Roster, ScoringLog, or other leagues
 *   - Does NOT modify driver2Boost or pitCrew2Boost (Phase 8D only boosted D1+PC1)
 *
 * Run:
 *   # Dry run (no writes):
 *   MONGODB_URI='...' node_modules/.bin/ts-node --project tsconfig.scripts.json \
 *     -r tsconfig-paths/register --transpile-only \
 *     scripts/backfill-miami-performance-selections.ts --dry-run
 *
 *   # Live (same command without --dry-run)
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { League, Roster, RaceCalendar, PerformanceSelection } from '@/lib/models';

const TEST_LEAGUE_INVITE_CODE = '9E3SHR';
const SEASON = 2026;
const ROUND  = 6;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log('\n=== Miami PerformanceSelection backfill ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}\n`);

  await connectDB();

  const calendar = await RaceCalendar.findOne({ season: SEASON, round: ROUND }).lean() as any;
  if (!calendar) {
    console.error('ERROR: Miami round 6 calendar entry not found.');
    process.exit(1);
  }
  if (calendar.miamiSelectionsBackfilled) {
    console.log('REFUSING TO RUN: miamiSelectionsBackfilled=true on Miami RaceCalendar.');
    console.log('To override, manually unset the flag in MongoDB.');
    process.exit(0);
  }
  console.log('Idempotency check passed.\n');

  const league = await League.findOne({ inviteCode: TEST_LEAGUE_INVITE_CODE }).lean() as any;
  if (!league) {
    console.error(`ERROR: League with inviteCode ${TEST_LEAGUE_INVITE_CODE} not found.`);
    process.exit(1);
  }
  console.log(`Test league: ${league.name} (${league._id})`);

  const rosters = await Roster.find({ leagueId: league._id, season: SEASON }).lean() as any[];
  console.log(`Found ${rosters.length} rosters.\n`);

  let upserted = 0;
  let skipped  = 0;

  for (const roster of rosters) {
    const userId = roster.userId;

    if (!roster.driver1AssetId || !roster.pitCrew1AssetId) {
      console.log(`  SKIP user ${userId}: missing driver1 or pitCrew1`);
      skipped++;
      continue;
    }

    if (dryRun) {
      const existing = await PerformanceSelection.findOne({
        leagueId: league._id, userId, season: SEASON, round: ROUND,
      }).lean() as any;
      const action = existing ? 'UPDATE' : 'INSERT';
      console.log(`  [${action}] user=${userId}  d1Boost=${roster.driver1AssetId}  pc1Boost=${roster.pitCrew1AssetId}  (existing locked=${existing?.locked ?? 'n/a'})`);
    } else {
      await PerformanceSelection.findOneAndUpdate(
        { leagueId: league._id, userId, season: SEASON, round: ROUND },
        {
          $set: {
            driver1Boost:  roster.driver1AssetId,
            pitCrew1Boost: roster.pitCrew1AssetId,
            locked:        true,
            submittedAt:   new Date(),
            autoFilled:    false,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      console.log(`  UPSERTED user=${userId}`);
    }
    upserted++;
  }

  console.log(`\nSummary: ${upserted} upserts, ${skipped} skipped.`);

  if (!dryRun) {
    await RaceCalendar.updateOne(
      { season: SEASON, round: ROUND },
      { $set: { miamiSelectionsBackfilled: true } },
    );
    console.log('\nSet miamiSelectionsBackfilled=true on Miami RaceCalendar.');
  } else {
    console.log('\n(Dry run — flag not set.)');
  }

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
