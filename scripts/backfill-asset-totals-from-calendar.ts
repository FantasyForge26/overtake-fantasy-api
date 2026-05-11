/**
 * backfill-asset-totals-from-calendar.ts
 *
 * Recomputes Asset.totalPoints (and avgPointsPerRace) for every active 2026
 * asset by re-summing all session points from RaceCalendar arrays. Fixes the
 * driver under-count where live scoring crons were updating Roster.totalPoints
 * but not Asset.totalPoints, leaving Asset display values short by the sprint
 * quali + sprint race + (in some cases) main quali points.
 *
 * Idempotent — replaces totals wholesale rather than incrementing, so re-runs
 * are safe.
 *
 * After updating totals, also runs recalculateAllOTFv2 to refresh OTF
 * ratings + components against the corrected averages.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx --env-file=.env.local scripts/backfill-asset-totals-from-calendar.ts
 *   npx tsx --env-file=.env.local scripts/backfill-asset-totals-from-calendar.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import { Asset, RaceCalendar } from '../lib/models';
import { recalculateAllOTFv2 } from '../lib/otf-recalculate';

const DRY_RUN = process.env.DRY_RUN === '1';
const SEASON  = 2026;

interface AssetTotals {
  totalPoints:    number;
  racesCompleted: number;
}

function sumDriverTotals(calendars: any[], driverSlug: string): AssetTotals {
  let totalPoints    = 0;
  let racesCompleted = 0;
  for (const cal of calendars) {
    const raceEntry = (cal.raceResults ?? []).find((e: any) => e.driverSlug === driverSlug);
    if (!raceEntry) continue;
    racesCompleted++;
    const qPts  = (cal.qualifyingResults  ?? []).filter((e: any) => e.driverSlug === driverSlug).reduce((s: number, e: any) => s + (e.points ?? 0), 0);
    const sqPts = (cal.sprintQualiResults ?? []).filter((e: any) => e.driverSlug === driverSlug).reduce((s: number, e: any) => s + (e.points ?? 0), 0);
    const srPts = (cal.sprintRaceResults  ?? []).filter((e: any) => e.driverSlug === driverSlug).reduce((s: number, e: any) => s + (e.points ?? 0), 0);
    const rPts  = raceEntry.points ?? 0;
    totalPoints += qPts + sqPts + srPts + rPts;
  }
  return { totalPoints: Math.round(totalPoints * 100) / 100, racesCompleted };
}

function sumPrincipalTotals(calendars: any[], principalSlug: string): AssetTotals {
  let totalPoints    = 0;
  let racesCompleted = 0;
  for (const cal of calendars) {
    const entries = (cal.principalResults ?? []).filter((e: any) => e.principalSlug === principalSlug);
    if (entries.length === 0) continue;
    racesCompleted++;
    totalPoints += entries.reduce((s: number, e: any) => s + (e.points ?? 0), 0);
  }
  return { totalPoints: Math.round(totalPoints * 100) / 100, racesCompleted };
}

function sumPitCrewTotals(calendars: any[], pitCrewSlug: string): AssetTotals {
  let totalPoints    = 0;
  let racesCompleted = 0;
  for (const cal of calendars) {
    const entry = (cal.pitCrewResults ?? []).find((e: any) => e.pitCrewSlug === pitCrewSlug);
    if (!entry) continue;
    racesCompleted++;
    totalPoints += entry.points ?? 0;
  }
  return { totalPoints: Math.round(totalPoints * 100) / 100, racesCompleted };
}

function sumPowerUnitTotals(calendars: any[], powerUnitSlug: string): AssetTotals {
  let totalPoints    = 0;
  let racesCompleted = 0;
  for (const cal of calendars) {
    const entries = (cal.powerUnitResults ?? []).filter((e: any) => e.powerUnitSlug === powerUnitSlug);
    if (entries.length === 0) continue;
    racesCompleted++;
    totalPoints += entries.reduce((s: number, e: any) => s + (e.points ?? 0), 0);
  }
  return { totalPoints: Math.round(totalPoints * 100) / 100, racesCompleted };
}

async function main() {
  console.log(`=== backfill-asset-totals-from-calendar ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);
  await connectDB();

  const calendars = await RaceCalendar.find({ season: SEASON }).sort({ round: 1 }).lean() as any[];
  const processedCalendars = calendars.filter(c => (c.raceResults ?? []).length > 0);
  console.log(`Found ${processedCalendars.length} processed rounds\n`);

  const assets = await Asset.find({ season: SEASON, isActive: true }).lean() as any[];
  console.log(`Found ${assets.length} active assets\n`);

  let updated = 0;
  let unchanged = 0;
  const movers: Array<{ slug: string; type: string; oldTotal: number; newTotal: number; delta: number }> = [];

  for (const asset of assets) {
    let totals: AssetTotals;
    switch (asset.assetType) {
      case 'driver':    totals = sumDriverTotals(processedCalendars, asset.slug); break;
      case 'principal': totals = sumPrincipalTotals(processedCalendars, asset.slug); break;
      case 'pitCrew':   totals = sumPitCrewTotals(processedCalendars, asset.slug); break;
      case 'powerUnit': totals = sumPowerUnitTotals(processedCalendars, asset.slug); break;
      default:          continue;
    }

    const oldTotal = asset.totalPoints ?? 0;
    const newTotal = totals.totalPoints;
    const newAvg   = totals.racesCompleted > 0
      ? Math.round((newTotal / totals.racesCompleted) * 100) / 100
      : 0;

    const delta = Math.round((newTotal - oldTotal) * 100) / 100;
    const sign  = delta > 0 ? '+' : '';

    console.log(
      `[${asset.assetType?.padEnd(10)}] ${asset.slug.padEnd(38)} ` +
      `total ${String(oldTotal).padStart(7)} → ${String(newTotal).padStart(7)} (${sign}${delta})  ` +
      `avg ${newAvg}  races ${totals.racesCompleted}`,
    );

    if (Math.abs(delta) >= 0.01) {
      movers.push({ slug: asset.slug, type: asset.assetType, oldTotal, newTotal, delta });
      if (!DRY_RUN) {
        await Asset.updateOne(
          { _id: asset._id },
          { $set: {
            totalPoints:      newTotal,
            avgPointsPerRace: newAvg,
            racesCompleted:   totals.racesCompleted,
          } },
        );
      }
      updated++;
    } else {
      unchanged++;
    }
  }

  console.log(`\n=== Asset totals summary ===`);
  console.log(`  Updated:   ${updated}`);
  console.log(`  Unchanged: ${unchanged}`);
  console.log(`  By type:`);
  const byType: Record<string, number> = {};
  for (const m of movers) byType[m.type] = (byType[m.type] ?? 0) + 1;
  for (const [t, c] of Object.entries(byType)) console.log(`    ${t.padEnd(10)} ${c} corrected`);

  // OTF recalc — avgPointsPerRace just changed, so PERF/FORM components shift
  if (!DRY_RUN) {
    console.log(`\n=== Running OTF v2 recalc against corrected totals ===`);
    const r = await recalculateAllOTFv2(SEASON);
    console.log(`  ${r.updated}/${r.total} ratings updated, ${r.movers.length} big movers (Δ≥3)`);
    if (r.movers.length > 0) {
      console.log(`  Top OTF shifts:`);
      for (const m of r.movers.slice(0, 10)) {
        const arrow = m.to > m.from ? '↑' : '↓';
        console.log(`    ${arrow} ${m.slug.padEnd(36)} ${m.from} → ${m.to}`);
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
