/**
 * recalculate-otf-v2.ts
 *
 * Recomputes Asset.otfRating AND Asset.otfComponents for every active 2026
 * asset using the new component-based calculateOTFv2() formula.
 *
 * Pulls per-race fantasy totals directly from RaceCalendar arrays (not from
 * Asset.totalPoints, which has a known under-counting bug for sprint
 * weekends). This way OTF is accurate even before the asset-totals bug is
 * fixed.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx --env-file=.env.local scripts/recalculate-otf-v2.ts
 *   npx tsx --env-file=.env.local scripts/recalculate-otf-v2.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import { Asset, HistoricalSeason, RaceCalendar } from '../lib/models';
import { calculateOTFv2, type PerRaceRowForOTF } from '../lib/otf-calculator';

const DRY_RUN = process.env.DRY_RUN === '1';
const SEASON  = 2026;

// ── Per-race row builders, one per asset type ─────────────────────────────

// driver_total_pts(round) = qPts + main rPts + sprint quali + sprint race  (matching the breakdown endpoints' "total" field)
function buildDriverRows(
  calendars: any[],
  driverSlug: string,
): PerRaceRowForOTF[] {
  const rows: PerRaceRowForOTF[] = [];
  for (const cal of calendars) {
    const raceEntry = (cal.raceResults ?? []).find((e: any) => e.driverSlug === driverSlug);
    if (!raceEntry) continue;

    const qPts = (cal.qualifyingResults ?? [])
      .filter((e: any) => e.driverSlug === driverSlug)
      .reduce((s: number, e: any) => s + (e.points ?? 0), 0);

    const sqPts = (cal.sprintQualiResults ?? [])
      .filter((e: any) => e.driverSlug === driverSlug)
      .reduce((s: number, e: any) => s + (e.points ?? 0), 0);

    const srPts = (cal.sprintRaceResults ?? [])
      .filter((e: any) => e.driverSlug === driverSlug)
      .reduce((s: number, e: any) => s + (e.points ?? 0), 0);

    const rPts = raceEntry.points ?? 0;
    const dnf  = !!raceEntry.notClassified || !!raceEntry.dsq;

    rows.push({
      round: cal.round,
      total: Math.round((qPts + sqPts + srPts + rPts) * 100) / 100,
      dnf,
    });
  }
  return rows;
}

function buildPrincipalRows(calendars: any[], principalSlug: string): PerRaceRowForOTF[] {
  const rows: PerRaceRowForOTF[] = [];
  for (const cal of calendars) {
    const entries = (cal.principalResults ?? []).filter((e: any) => e.principalSlug === principalSlug);
    if (entries.length === 0) continue;
    rows.push({
      round: cal.round,
      total: Math.round(entries.reduce((s: number, e: any) => s + (e.points ?? 0), 0) * 100) / 100,
    });
  }
  return rows;
}

function buildPitCrewRows(calendars: any[], pitCrewSlug: string): PerRaceRowForOTF[] {
  const rows: PerRaceRowForOTF[] = [];
  for (const cal of calendars) {
    const entry = (cal.pitCrewResults ?? []).find((e: any) => e.pitCrewSlug === pitCrewSlug);
    if (!entry) continue;
    rows.push({
      round: cal.round,
      total: entry.points ?? 0,
    });
  }
  return rows;
}

function buildPowerUnitRows(calendars: any[], powerUnitSlug: string): PerRaceRowForOTF[] {
  const rows: PerRaceRowForOTF[] = [];
  for (const cal of calendars) {
    const entries = (cal.powerUnitResults ?? []).filter((e: any) => e.powerUnitSlug === powerUnitSlug);
    if (entries.length === 0) continue;
    rows.push({
      round: cal.round,
      total: Math.round(entries.reduce((s: number, e: any) => s + (e.points ?? 0), 0) * 100) / 100,
    });
  }
  return rows;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== recalculate-otf-v2 ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);
  await connectDB();

  const calendars = await RaceCalendar.find({ season: SEASON }).sort({ round: 1 }).lean() as any[];
  const processedCalendars = calendars.filter(c => (c.raceResults ?? []).length > 0);
  console.log(`Loaded ${calendars.length} calendars (${processedCalendars.length} processed rounds)\n`);

  const assets = await Asset.find({ season: SEASON, isActive: true }).lean() as any[];
  console.log(`Found ${assets.length} active 2026 assets\n`);

  const movers: Array<{ slug: string; type: string; from: number; to: number; components: any }> = [];
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

    let perRaceRows: PerRaceRowForOTF[] = [];
    switch (asset.assetType) {
      case 'driver':    perRaceRows = buildDriverRows(processedCalendars, asset.slug); break;
      case 'principal': perRaceRows = buildPrincipalRows(processedCalendars, asset.slug); break;
      case 'pitCrew':   perRaceRows = buildPitCrewRows(processedCalendars, asset.slug); break;
      case 'powerUnit': perRaceRows = buildPowerUnitRows(processedCalendars, asset.slug); break;
    }

    const { rating: newRating, components } = calculateOTFv2({
      assetType:        asset.assetType,
      otfBaseRating:    asset.otfBaseRating ?? 50,
      perRaceRows,
      historicalSeasons,
    });

    const oldRating = asset.otfRating ?? 0;
    const delta = newRating - oldRating;
    const sign  = delta > 0 ? '+' : '';

    console.log(
      `[${asset.assetType?.padEnd(10)}] ${asset.slug.padEnd(36)} ${String(oldRating).padStart(3)} → ${String(newRating).padStart(3)}  (${sign}${delta})  ` +
      `P${String(components.perf).padStart(2)} F${String(components.form).padStart(2)} C${String(components.cons).padStart(2)} H${String(components.hist).padStart(2)} B${String(components.base).padStart(2)}  ` +
      `[rows:${perRaceRows.length} hist:${historicalSeasons.filter(h => h.season < 2026 && h.racesCompleted >= 5).length}]`,
    );

    if (Math.abs(delta) >= 5 || asset.slug === 'kimi-antonelli' || asset.slug === 'lando-norris') {
      movers.push({ slug: asset.slug, type: asset.assetType, from: oldRating, to: newRating, components });
    }

    if (!DRY_RUN) {
      await Asset.updateOne(
        { _id: asset._id },
        { $set: { otfRating: newRating, otfComponents: components } },
      );
    }

    if (newRating !== oldRating) updated++; else unchanged++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Total:     ${assets.length}`);
  console.log(`  Changed:   ${updated}`);
  console.log(`  Unchanged: ${unchanged}`);

  if (movers.length > 0) {
    console.log(`\n  Notable movers & watched:`);
    for (const m of movers.sort((a, b) => b.to - a.to)) {
      const arrow = m.to > m.from ? '↑' : m.to < m.from ? '↓' : '·';
      console.log(`    ${arrow} ${m.slug.padEnd(36)} (${m.type.padEnd(10)})  ${m.from} → ${m.to}  P${m.components.perf} F${m.components.form} C${m.components.cons} H${m.components.hist} B${m.components.base}`);
    }
  }

  if (DRY_RUN) console.log('\nDRY RUN complete — no writes made.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
