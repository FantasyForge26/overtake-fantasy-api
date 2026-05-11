/**
 * verify-otf-vs-avg.ts
 *
 * Within each asset type, lists assets sorted by avgPointsPerRace and by
 * OTF rating side by side. Flags inversions where an asset with higher avg
 * has lower OTF than another asset (or vice versa).
 *
 * Per-race avgs come from the breakdown endpoints / RaceCalendar arrays —
 * recomputed inline rather than relying on Asset.avgPointsPerRace so we get
 * the same "true" totals we'd see in the UI.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/verify-otf-vs-avg.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import { Asset, RaceCalendar } from '../lib/models';

const SEASON = 2026;

async function main() {
  await connectDB();

  const calendars = await RaceCalendar.find({ season: SEASON }).sort({ round: 1 }).lean() as any[];
  const processed = calendars.filter(c => (c.raceResults ?? []).length > 0);

  const assets = await Asset.find({ season: SEASON, isActive: true }).lean() as any[];

  // Compute true avg per asset (matches the UI's "Avg Pts/Race" calculation)
  function avgFor(asset: any): { total: number; races: number; avg: number } {
    let total = 0, races = 0;
    for (const cal of processed) {
      if (asset.assetType === 'driver') {
        const r = (cal.raceResults ?? []).find((e: any) => e.driverSlug === asset.slug);
        if (!r) continue;
        races++;
        const q  = (cal.qualifyingResults  ?? []).filter((e: any) => e.driverSlug === asset.slug).reduce((s: number, e: any) => s + (e.points ?? 0), 0);
        const sq = (cal.sprintQualiResults ?? []).filter((e: any) => e.driverSlug === asset.slug).reduce((s: number, e: any) => s + (e.points ?? 0), 0);
        const sr = (cal.sprintRaceResults  ?? []).filter((e: any) => e.driverSlug === asset.slug).reduce((s: number, e: any) => s + (e.points ?? 0), 0);
        total += q + sq + sr + (r.points ?? 0);
      } else if (asset.assetType === 'principal') {
        const es = (cal.principalResults ?? []).filter((e: any) => e.principalSlug === asset.slug);
        if (!es.length) continue;
        races++;
        total += es.reduce((s: number, e: any) => s + (e.points ?? 0), 0);
      } else if (asset.assetType === 'pitCrew') {
        const e = (cal.pitCrewResults ?? []).find((x: any) => x.pitCrewSlug === asset.slug);
        if (!e) continue;
        races++;
        total += e.points ?? 0;
      } else if (asset.assetType === 'powerUnit') {
        const es = (cal.powerUnitResults ?? []).filter((e: any) => e.powerUnitSlug === asset.slug);
        if (!es.length) continue;
        races++;
        total += es.reduce((s: number, e: any) => s + (e.points ?? 0), 0);
      }
    }
    return {
      total: Math.round(total * 100) / 100,
      races,
      avg: races > 0 ? Math.round((total / races) * 100) / 100 : 0,
    };
  }

  const types: Array<'driver' | 'principal' | 'pitCrew' | 'powerUnit'> = ['driver', 'principal', 'pitCrew', 'powerUnit'];

  for (const t of types) {
    const list = assets.filter(a => a.assetType === t).map(a => ({
      slug: a.slug,
      otf:  a.otfRating ?? 0,
      ...avgFor(a),
    }));

    console.log(`\n=== ${t.toUpperCase()} — sorted by AVG pts/race ===`);
    const byAvg = [...list].sort((a, b) => b.avg - a.avg);
    byAvg.forEach((a, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${a.slug.padEnd(38)} avg ${String(a.avg).padStart(6)}  OTF ${String(a.otf).padStart(3)}  total ${a.total}`);
    });

    // Count inversions: pairs where higher-avg has lower-OTF
    const ranked = [...list].sort((a, b) => b.avg - a.avg);
    let inversions = 0;
    const inversionPairs: Array<[string, string]> = [];
    for (let i = 0; i < ranked.length; i++) {
      for (let j = i + 1; j < ranked.length; j++) {
        // ranked[i] has higher avg than ranked[j]; check OTF
        if (ranked[i].otf < ranked[j].otf) {
          inversions++;
          if (inversionPairs.length < 5) {
            inversionPairs.push([
              `${ranked[i].slug} (avg ${ranked[i].avg}, OTF ${ranked[i].otf})`,
              `${ranked[j].slug} (avg ${ranked[j].avg}, OTF ${ranked[j].otf})`,
            ]);
          }
        }
      }
    }
    console.log(`  Inversions: ${inversions}${inversions > 0 ? '  (top examples below)' : ''}`);
    for (const [hi, lo] of inversionPairs) {
      console.log(`    !  ${hi}  has LOWER OTF than  ${lo}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
