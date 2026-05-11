/**
 * recalculate-otf.ts
 *
 * Recomputes Asset.otfRating for every active 2026 asset using the current
 * calculateOTFRating() formula. Pulls historical season data from
 * HistoricalSeason and the asset's own racesCompleted / avgPointsPerRace.
 *
 * Why run this:
 *   - Whenever the formula or its weights change (see lib/otf-calculator.ts)
 *   - After backfilling historical data
 *   - Whenever you want to sync ratings to the latest live performance
 *
 * Usage:
 *   DRY_RUN=1 npx tsx --env-file=.env.local scripts/recalculate-otf.ts
 *   npx tsx --env-file=.env.local scripts/recalculate-otf.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import { Asset, HistoricalSeason } from '../lib/models';
import { calculateOTFRating } from '../lib/otf-calculator';

const DRY_RUN = process.env.DRY_RUN === '1';

async function main() {
  console.log(`=== recalculate-otf ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);

  await connectDB();

  const assets = await Asset.find({ season: 2026, isActive: true }).lean() as any[];
  console.log(`Found ${assets.length} active 2026 assets\n`);

  const byType: Record<string, { count: number; sumDelta: number; movers: { slug: string; from: number; to: number }[] }> = {};
  let updated = 0;
  let unchanged = 0;

  for (const asset of assets) {
    const historicalDocs = await HistoricalSeason.find({ assetSlug: asset.slug }).lean() as any[];

    const historicalSeasons = historicalDocs.map((h: any) => ({
      season:           h.season,
      wins:             h.wins ?? 0,
      podiums:          h.podiums ?? 0,
      racesCompleted:   h.racesCompleted ?? 0,
      q3Count:          h.q3Count ?? 0,
      qualifyingRaces:  h.qualifyingRaces ?? 0,
      dnfCount:         h.dnfCount ?? 0,
      avgPointsPerRace: h.avgPointsPerRace ?? 0,
      championshipWins: h.championshipWins ?? 0,
    }));

    const oldRating = asset.otfRating ?? 0;

    const newRating = calculateOTFRating({
      otfBaseRating:    asset.otfBaseRating ?? 50,
      racesCompleted:   asset.racesCompleted ?? 0,
      avgPointsPerRace: asset.avgPointsPerRace ?? 0,
      totalPoints:      asset.totalPoints ?? 0,
      age:              asset.age,
      teamStrength:     asset.teamStrength ?? 50,
      dnfCount:         asset.dnfCount ?? 0,
      assetType:        asset.assetType,
      championshipWins: asset.championshipWins,
      historicalSeasons,
    });

    const delta = newRating - oldRating;
    const sign  = delta > 0 ? '+' : '';

    const t = asset.assetType ?? 'unknown';
    if (!byType[t]) byType[t] = { count: 0, sumDelta: 0, movers: [] };
    byType[t].count++;
    byType[t].sumDelta += delta;
    if (Math.abs(delta) >= 5) {
      byType[t].movers.push({ slug: asset.slug, from: oldRating, to: newRating });
    }

    console.log(
      `[${t.padEnd(10)}] ${asset.slug.padEnd(36)} ${String(oldRating).padStart(3)} → ${String(newRating).padStart(3)}  (${sign}${delta})` +
      (historicalSeasons.length ? `  [${historicalSeasons.length} hist]` : '  [no hist]'),
    );

    if (delta !== 0 && !DRY_RUN) {
      await Asset.updateOne({ _id: asset._id }, { $set: { otfRating: newRating } });
    }
    if (delta !== 0) updated++; else unchanged++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Total assets:    ${assets.length}`);
  console.log(`  Changed:         ${updated}`);
  console.log(`  Unchanged:       ${unchanged}`);
  console.log('');
  console.log(`  Per asset type:`);
  for (const [type, info] of Object.entries(byType)) {
    const avgDelta = info.count > 0 ? (info.sumDelta / info.count).toFixed(2) : '0';
    console.log(`    ${type.padEnd(10)}  count=${info.count}  avgΔ=${avgDelta}`);
    if (info.movers.length > 0) {
      console.log(`      Big movers (Δ≥5):`);
      for (const m of info.movers.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from)).slice(0, 8)) {
        const arrow = m.to > m.from ? '↑' : '↓';
        console.log(`        ${arrow} ${m.slug.padEnd(36)}  ${m.from} → ${m.to}`);
      }
    }
  }

  if (DRY_RUN) console.log('\nDRY RUN complete — no writes made.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
