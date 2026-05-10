/**
 * correct-boost-counters-rule3.ts
 *
 * One-off correction for the 2026 season boost counter init bug.
 *
 * BACKGROUND
 * ──────────
 * Phase 8D shipped the Miami boost backfill (scripts/backfill-miami-boosts.ts).
 * It initialized Asset.boostsRemaining = 12 − 6 = 6 on all 2026 driver/pitCrew
 * assets, treating "6 prior rounds" as the slots-elapsed count (Rule 2: 1 slot
 * per calendar round, cancelled or not).
 *
 * BUT only 4 races actually happened in those 6 rounds — R4 BHR and R5 SAU were
 * cancelled. Per the formally adopted boost rule (see lib/models.ts), slots are
 * tied to actual races, not scheduled rounds. So init should have been 12 − 4 = 8.
 *
 * BOOST COUNTER RULE (Rule 3, adopted)
 * ────────────────────────────────────
 *   - Each driver/pitCrew asset starts each season with 12 boost slots.
 *   - Each actual race weekend (cancelled races excluded), the asset's slot
 *     count decreases by 1 IF the asset is selected as a boost in that round
 *     by any roster.
 *   - Cancelled races do NOT consume slots.
 *   - In normal seasons (no cancellations), this is identical to Rule 2.
 *
 * THIS SCRIPT
 * ───────────
 * Bumps boostsRemaining by +2 on every active 2026 driver/pitCrew asset to
 * compensate for the over-deduction at Miami init.
 *
 *   Asset never boosted:        6 → 8 ✓ (12 − 4 races)
 *   Asset boosted once (Miami): 5 → 7 ✓ (12 − 4 races, 1 spent)
 *
 * IDEMPOTENCY: this script SHOULD only run once. The seasonBoostInitCorrected
 * flag on the Miami RaceCalendar doc is set to prevent re-runs.
 *
 * Usage:
 *   DRY_RUN=1 npx ts-node --project tsconfig.scripts.json \
 *     -r tsconfig-paths/register --transpile-only \
 *     scripts/correct-boost-counters-rule3.ts
 *
 *   # live:
 *   npx ts-node --project tsconfig.scripts.json \
 *     -r tsconfig-paths/register --transpile-only \
 *     scripts/correct-boost-counters-rule3.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import { Asset, RaceCalendar } from '../lib/models';

const SEASON           = 2026;
const MIAMI_ROUND      = 6;
const BOOST_BUMP       = 2;   // 12 − 4 races (8) − previous init (6) = 2
const SLOT_CAP         = 12;
const DRY_RUN          = process.env.DRY_RUN === '1';

async function main() {
  console.log(`=== correct-boost-counters-rule3 ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);

  await connectDB();

  // Idempotency check
  const miami = await RaceCalendar.findOne({ season: SEASON, round: MIAMI_ROUND }).lean() as any;
  if (!miami) {
    console.log(`No RaceCalendar doc for season=${SEASON} round=${MIAMI_ROUND}. Aborting.`);
    await mongoose.disconnect();
    return;
  }
  if (miami.seasonBoostInitCorrected) {
    console.log('seasonBoostInitCorrected=true on Miami doc — already applied. Aborting.');
    await mongoose.disconnect();
    return;
  }

  // Snapshot all affected assets
  const assets = await Asset.find({
    season:    SEASON,
    isActive:  true,
    assetType: { $in: ['driver', 'pitCrew'] },
  }).lean() as any[];

  console.log(`Found ${assets.length} active 2026 driver/pitCrew assets\n`);

  let bumped = 0;
  let cappedSkipped = 0;

  for (const a of assets) {
    const old = a.boostsRemaining ?? 12;
    const next = Math.min(old + BOOST_BUMP, SLOT_CAP);
    const delta = next - old;

    if (delta === 0) {
      cappedSkipped++;
      continue;
    }

    console.log(`  ${a.slug.padEnd(36)} ${a.assetType.padEnd(8)} ${old} → ${next}  (+${delta})`);

    if (!DRY_RUN) {
      await Asset.updateOne({ _id: a._id }, { $set: { boostsRemaining: next } });
    }
    bumped++;
  }

  console.log(`\n  Bumped:        ${DRY_RUN ? '(dry run — would bump)' : ''} ${bumped}`);
  console.log(`  Capped (skip): ${cappedSkipped}`);

  if (!DRY_RUN) {
    await RaceCalendar.updateOne(
      { _id: miami._id },
      { $set: { seasonBoostInitCorrected: true } },
    );
    console.log('  seasonBoostInitCorrected=true set on Miami doc');
  }

  console.log('\n=== Done ===');
  if (DRY_RUN) console.log('DRY RUN complete — no writes made.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
