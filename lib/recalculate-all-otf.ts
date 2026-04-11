/**
 * Recalculate OTF ratings for all 2026 assets using current formula.
 *
 * Usage:
 *   MONGODB_URI='...' npx ts-node --compiler-options '{"module":"commonjs"}' lib/recalculate-all-otf.ts
 */

import mongoose from 'mongoose';
import { connectDB } from './db';
import { Asset, HistoricalSeason } from './models';
import { calculateOTFRating } from './otf-calculator';

async function main() {
  await connectDB();
  console.log('Connected to MongoDB\n');

  const assets = await Asset.find({ season: 2026, isActive: true }).lean() as any[];
  console.log(`Found ${assets.length} active 2026 assets\n`);

  const byType: Record<string, number> = {};
  let updated = 0;

  for (const asset of assets) {
    // Load historical seasons for this asset
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
    console.log(
      `[${asset.assetType?.padEnd(10)}] ${asset.slug.padEnd(35)} ${String(oldRating).padStart(3)} → ${String(newRating).padStart(3)}  (${sign}${delta})` +
      (historicalSeasons.length ? `  [${historicalSeasons.length} hist seasons]` : ''),
    );

    await Asset.findByIdAndUpdate(asset._id, { otfRating: newRating });

    byType[asset.assetType] = (byType[asset.assetType] ?? 0) + 1;
    updated++;
  }

  console.log(`\nDone. Updated ${updated} assets:`);
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${type}: ${count}`);
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
