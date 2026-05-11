/**
 * otf-recalculate.ts
 *
 * Shared helper that recomputes Asset.otfRating + Asset.otfComponents for
 * every active asset in a given season. Pulls per-race totals directly from
 * RaceCalendar arrays so it's accurate even before the asset-totals bug is
 * fixed (sprint quali / sprint race points still missing from Asset.totalPoints).
 *
 * Used by:
 *   - scripts/recalculate-otf-v2.ts  — manual one-off recalc
 *   - lib/scoring/process-race-logic.ts — automatic recalc after each race
 *
 * Idempotent and safe to re-run; only writes Assets whose rating changes.
 */

import { Asset, HistoricalSeason, RaceCalendar } from './models';
import { calculateOTFv2, type PerRaceRowForOTF } from './otf-calculator';

function rowsForDriver(calendars: any[], slug: string): PerRaceRowForOTF[] {
  const rows: PerRaceRowForOTF[] = [];
  for (const cal of calendars) {
    const raceEntry = (cal.raceResults ?? []).find((e: any) => e.driverSlug === slug);
    if (!raceEntry) continue;
    const qPts  = (cal.qualifyingResults  ?? []).filter((e: any) => e.driverSlug === slug).reduce((s: number, e: any) => s + (e.points ?? 0), 0);
    const sqPts = (cal.sprintQualiResults ?? []).filter((e: any) => e.driverSlug === slug).reduce((s: number, e: any) => s + (e.points ?? 0), 0);
    const srPts = (cal.sprintRaceResults  ?? []).filter((e: any) => e.driverSlug === slug).reduce((s: number, e: any) => s + (e.points ?? 0), 0);
    const rPts  = raceEntry.points ?? 0;
    rows.push({
      round: cal.round,
      total: Math.round((qPts + sqPts + srPts + rPts) * 100) / 100,
      dnf:   !!raceEntry.notClassified || !!raceEntry.dsq,
    });
  }
  return rows;
}

function rowsForPrincipal(calendars: any[], slug: string): PerRaceRowForOTF[] {
  return calendars
    .map(cal => {
      const entries = (cal.principalResults ?? []).filter((e: any) => e.principalSlug === slug);
      if (entries.length === 0) return null;
      return {
        round: cal.round,
        total: Math.round(entries.reduce((s: number, e: any) => s + (e.points ?? 0), 0) * 100) / 100,
      } as PerRaceRowForOTF;
    })
    .filter((r): r is PerRaceRowForOTF => r !== null);
}

function rowsForPitCrew(calendars: any[], slug: string): PerRaceRowForOTF[] {
  return calendars
    .map(cal => {
      const entry = (cal.pitCrewResults ?? []).find((e: any) => e.pitCrewSlug === slug);
      if (!entry) return null;
      return { round: cal.round, total: entry.points ?? 0 } as PerRaceRowForOTF;
    })
    .filter((r): r is PerRaceRowForOTF => r !== null);
}

function rowsForPowerUnit(calendars: any[], slug: string): PerRaceRowForOTF[] {
  return calendars
    .map(cal => {
      const entries = (cal.powerUnitResults ?? []).filter((e: any) => e.powerUnitSlug === slug);
      if (entries.length === 0) return null;
      return {
        round: cal.round,
        total: Math.round(entries.reduce((s: number, e: any) => s + (e.points ?? 0), 0) * 100) / 100,
      } as PerRaceRowForOTF;
    })
    .filter((r): r is PerRaceRowForOTF => r !== null);
}

function buildRowsForAsset(calendars: any[], asset: any): PerRaceRowForOTF[] {
  switch (asset.assetType) {
    case 'driver':    return rowsForDriver(calendars, asset.slug);
    case 'principal': return rowsForPrincipal(calendars, asset.slug);
    case 'pitCrew':   return rowsForPitCrew(calendars, asset.slug);
    case 'powerUnit': return rowsForPowerUnit(calendars, asset.slug);
    default:          return [];
  }
}

export interface RecalcResult {
  total:     number;
  updated:   number;
  unchanged: number;
  movers:    Array<{ slug: string; type: string; from: number; to: number }>;
}

export async function recalculateAllOTFv2(season: number): Promise<RecalcResult> {
  const calendars = await RaceCalendar.find({ season }).sort({ round: 1 }).lean() as any[];
  const processedCalendars = calendars.filter(c => (c.raceResults ?? []).length > 0);

  const assets = await Asset.find({ season, isActive: true }).lean() as any[];

  // Pre-fetch all historical seasons in one shot to avoid N+1 queries
  const slugs = assets.map(a => a.slug);
  const allHistorical = await HistoricalSeason.find({ assetSlug: { $in: slugs } }).lean() as any[];
  const historicalBySlug = new Map<string, any[]>();
  for (const h of allHistorical) {
    const list = historicalBySlug.get(h.assetSlug) ?? [];
    list.push(h);
    historicalBySlug.set(h.assetSlug, list);
  }

  let updated = 0;
  let unchanged = 0;
  const movers: RecalcResult['movers'] = [];

  for (const asset of assets) {
    const historicalSeasons = (historicalBySlug.get(asset.slug) ?? []).map(h => ({
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

    const perRaceRows = buildRowsForAsset(processedCalendars, asset);

    const { rating: newRating, components } = calculateOTFv2({
      assetType:        asset.assetType,
      otfBaseRating:    asset.otfBaseRating ?? 50,
      perRaceRows,
      historicalSeasons,
    });

    const oldRating = asset.otfRating ?? 0;

    if (newRating === oldRating &&
        asset.otfComponents?.perf === components.perf &&
        asset.otfComponents?.form === components.form &&
        asset.otfComponents?.cons === components.cons &&
        asset.otfComponents?.hist === components.hist &&
        asset.otfComponents?.base === components.base) {
      unchanged++;
      continue;
    }

    await Asset.updateOne(
      { _id: asset._id },
      { $set: { otfRating: newRating, otfComponents: components } },
    );
    updated++;

    if (Math.abs(newRating - oldRating) >= 3) {
      movers.push({ slug: asset.slug, type: asset.assetType, from: oldRating, to: newRating });
    }
  }

  return { total: assets.length, updated, unchanged, movers };
}
