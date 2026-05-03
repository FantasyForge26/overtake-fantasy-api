/**
 * boost-helper.ts
 *
 * Loads and exposes per-roster boost selections for a given race.
 * Used by scoring paths (process-race-logic, live crons) to apply the 2x multiplier.
 *
 * Design:
 *   - One PerformanceSelection per user per round holds up to:
 *       driver1Boost, driver2Boost   (up to 1 driver boost per race)
 *       pitCrew1Boost, pitCrew2Boost (up to 1 pit crew boost per race)
 *   - All four fields are asset ObjectId refs, nullable.
 *   - Only locked selections are included (locked = true means finalized before race start).
 *   - The 2x multiplier applies to ALL session points for the boosted asset across the full race weekend.
 */

import { PerformanceSelection, Asset, Roster } from '@/lib/models';

/** Map from rosterId (string) → Set of asset slugs boosted for this race. */
export interface BoostedSlots {
  byRoster: Map<string, Set<string>>;
}

/**
 * Load all locked boost selections for a league + round and resolve asset slugs.
 * Returns a BoostedSlots map keyed by rosterId.toString().
 */
export async function loadBoostedSlots(
  leagueId: string,
  round: number,
  season: number,
): Promise<BoostedSlots> {
  const byRoster = new Map<string, Set<string>>();

  // Fetch locked selections for this round
  const selections = await PerformanceSelection.find({
    leagueId,
    round,
    season,
    locked: true,
  }).lean() as any[];

  if (!selections.length) return { byRoster };

  // Collect all non-null asset ObjectIds across all boost fields
  const boostFields = ['driver1Boost', 'driver2Boost', 'pitCrew1Boost', 'pitCrew2Boost'] as const;
  const assetIdSet = new Set<string>();

  for (const sel of selections) {
    for (const field of boostFields) {
      if (sel[field]) assetIdSet.add(sel[field].toString());
    }
  }

  // Load slug for each referenced asset in one query
  const assetDocs = await Asset.find({
    _id: { $in: Array.from(assetIdSet) },
  }).lean() as any[];
  const slugById = new Map<string, string>(
    assetDocs.map((a: any) => [a._id.toString(), a.slug as string]),
  );

  // Build rosterId → boosted slugs map
  // PerformanceSelection has userId + leagueId but not rosterId directly;
  // we resolve via Roster for accuracy.
  const rosters = await Roster.find({ leagueId, season }).lean() as any[];
  const rosterIdByUserId = new Map<string, string>(
    rosters.map((r: any) => [r.userId.toString(), r._id.toString()]),
  );

  for (const sel of selections) {
    const rosterId = rosterIdByUserId.get(sel.userId?.toString() ?? '');
    if (!rosterId) continue;

    const slugs = new Set<string>();
    for (const field of boostFields) {
      if (sel[field]) {
        const slug = slugById.get(sel[field].toString());
        if (slug) slugs.add(slug);
      }
    }

    if (slugs.size > 0) {
      byRoster.set(rosterId, slugs);
    }
  }

  return { byRoster };
}

/**
 * Returns true if the given asset slug is boosted for this roster in this race.
 * Usage: `const multiplier = isBoosted(boosts, roster._id.toString(), asset.slug) ? 2 : 1;`
 */
export function isBoosted(boosts: BoostedSlots, rosterId: string, slug: string): boolean {
  return boosts.byRoster.get(rosterId)?.has(slug) ?? false;
}
