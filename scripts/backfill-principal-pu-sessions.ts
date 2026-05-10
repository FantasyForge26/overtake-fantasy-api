/**
 * backfill-principal-pu-sessions.ts
 *
 * Rewrites RaceCalendar.principalResults and .powerUnitResults to the new
 * per-session format (one entry per team/manufacturer per session, with
 * session, avgPosition, rawPoints, points fields).
 *
 * Also recomputes Asset.totalPoints / avgPointsPerRace for all affected
 * principal and PU assets, then adjusts Roster.totalPoints accordingly
 * and re-ranks rosters within each league.
 *
 * Processes all 2026 rounds with raceResults.length > 0.
 *
 * Usage:
 *   DRY_RUN=1 npx ts-node --project tsconfig.scripts.json \
 *     -r tsconfig-paths/register --transpile-only \
 *     scripts/backfill-principal-pu-sessions.ts
 *
 *   # live:
 *   npx ts-node --project tsconfig.scripts.json \
 *     -r tsconfig-paths/register --transpile-only \
 *     scripts/backfill-principal-pu-sessions.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import { Asset, RaceCalendar, Roster } from '../lib/models';
import { POWER_UNIT_MAP } from '../lib/scoring/process-race-logic';
import {
  calculatePrincipalSessionScore,
  PrincipalSessionInput,
  SessionType,
} from '../lib/scoring/principal-session';
import {
  calculatePowerUnitSessionScores,
  CarSessionData,
} from '../lib/scoring/powerunit-session';

const DRY_RUN = process.env.DRY_RUN === '1';

function r2(n: number) {
  return Math.round(n * 100) / 100;
}

async function main() {
  console.log(`=== backfill-principal-pu-sessions ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);

  await connectDB();

  // ── Load static lookups ────────────────────────────────────────────────────

  const allAssets = await Asset.find({ season: 2026, isActive: true }).lean() as any[];

  // teamSlug → principalSlug
  const principalByTeam = new Map<string, string>();
  for (const a of allAssets) {
    if (a.assetType === 'principal') principalByTeam.set(a.teamSlug, a.slug);
  }

  // teamSlug → [driver1Slug, driver2Slug]
  const driversByTeam = new Map<string, string[]>();
  for (const a of allAssets) {
    if (a.assetType === 'driver' && a.teamSlug) {
      const arr = driversByTeam.get(a.teamSlug) ?? [];
      arr.push(a.slug);
      driversByTeam.set(a.teamSlug, arr);
    }
  }

  // driverSlug → teamSlug (for PU manufacturer lookup)
  const teamByDriverSlug = new Map<string, string>();
  for (const a of allAssets) {
    if (a.assetType === 'driver' && a.teamSlug) teamByDriverSlug.set(a.slug, a.teamSlug);
  }

  // teamName → teamSlug (POWER_UNIT_MAP uses teamName keys)
  // Build by matching asset.name / asset.teamName fields
  // Drivers have a teamName field we can use, or we can derive from teamSlug
  // Actually POWER_UNIT_MAP uses display team names like 'Red Bull Racing'.
  // Assets have a teamSlug like 'red-bull'. We need team display name → slug.
  // Build from driver assets: teamSlug → first driver's team display name isn't stored cleanly.
  // Instead, build manufacturer from teamSlug using a local map that mirrors POWER_UNIT_MAP keys.
  const TEAM_SLUG_TO_NAME: Record<string, string> = {
    'red-bull':      'Red Bull Racing',
    'racing-bulls':  'Racing Bulls',
    'cadillac':      'Cadillac',
    'mercedes':      'Mercedes',
    'mclaren':       'McLaren',
    'williams':      'Williams',
    'ferrari':       'Ferrari',
    'haas':          'Haas',
    'aston-martin':  'Aston Martin',
    'alpine':        'Alpine',
    'audi':          'Audi',
  };

  // manufacturer → [powerUnitSlug, ...]
  const puSlugsByManufacturer = new Map<string, string[]>();
  for (const a of allAssets) {
    if (a.assetType === 'powerUnit' && a.manufacturer) {
      const arr = puSlugsByManufacturer.get(a.manufacturer) ?? [];
      arr.push(a.slug);
      puSlugsByManufacturer.set(a.manufacturer, arr);
    }
  }

  // ── Find processed rounds ──────────────────────────────────────────────────

  const calendars = await RaceCalendar.find({ season: 2026 }).sort({ round: 1 }) as any[];
  const processedCals = calendars.filter((c: any) => (c.raceResults ?? []).length > 0);
  console.log(`Found ${processedCals.length} processed rounds\n`);

  // ── Snapshot old totals (for roster delta) ─────────────────────────────────

  const principalAssets = allAssets.filter(a => a.assetType === 'principal');
  const puAssets         = allAssets.filter(a => a.assetType === 'powerUnit');

  const oldTotals = new Map<string, number>();
  for (const a of [...principalAssets, ...puAssets]) {
    oldTotals.set(a.slug, a.totalPoints ?? 0);
  }

  // ── Process each round ────────────────────────────────────────────────────

  let calUpdatedCount = 0;

  // Track new entries across all rounds so the asset-totals printout works
  // correctly in DRY_RUN (where DB never gets written).
  const allNewPrincipalEntries: any[] = [];
  const allNewPowerUnitEntries: any[] = [];

  for (const cal of processedCals) {
    const round: number   = cal.round;
    const isSprint: boolean = cal.isSprint ?? false;
    console.log(`R${round} ${cal.country ?? ''} (isSprint=${isSprint})`);

    // Build pos maps: driverSlug → position
    const qualiPosMap       = new Map<string, number>();
    const racePosMap        = new Map<string, number>();
    const sprintQualiPosMap = new Map<string, number>();
    const sprintRacePosMap  = new Map<string, number>();

    for (const e of (cal.qualifyingResults ?? [])) {
      if (e.driverSlug && e.position != null) qualiPosMap.set(e.driverSlug, e.position);
    }
    for (const e of (cal.raceResults ?? [])) {
      if (e.driverSlug && e.position != null && !e.notClassified && !e.dsq) {
        racePosMap.set(e.driverSlug, e.position);
      }
    }
    if (isSprint) {
      for (const e of (cal.sprintQualiResults ?? [])) {
        if (e.driverSlug && e.position != null) sprintQualiPosMap.set(e.driverSlug, e.position);
      }
      for (const e of (cal.sprintRaceResults ?? [])) {
        if (e.driverSlug && e.position != null) sprintRacePosMap.set(e.driverSlug, e.position);
      }
    }

    const sessions: SessionType[] = isSprint
      ? ['sprintQuali', 'sprintRace', 'qualifying', 'race']
      : ['qualifying', 'race'];

    function posMapForSession(s: SessionType): Map<string, number> {
      switch (s) {
        case 'sprintQuali': return sprintQualiPosMap;
        case 'sprintRace':  return sprintRacePosMap;
        case 'qualifying':  return qualiPosMap;
        case 'race':        return racePosMap;
      }
    }

    // ── Principal entries ──────────────────────────────────────────────────

    const newPrincipalEntries: any[] = [];

    for (const [teamSlug, principalSlug] of principalByTeam) {
      const teamName = TEAM_SLUG_TO_NAME[teamSlug];
      if (!teamName) continue;

      const driverSlugs = driversByTeam.get(teamSlug) ?? [];
      const [d1Slug, d2Slug] = driverSlugs;

      for (const session of sessions) {
        const posMap = posMapForSession(session);
        const d1Pos = d1Slug ? (posMap.get(d1Slug) ?? null) : null;
        const d2Pos = d2Slug ? (posMap.get(d2Slug) ?? null) : null;

        const input: PrincipalSessionInput = {
          teamName,
          driver1Position: d1Pos,
          driver2Position: d2Pos,
          session,
        };
        const result = calculatePrincipalSessionScore(input);

        newPrincipalEntries.push({
          principalSlug,
          session,
          avgPosition: result.avgPosition,
          rawPoints:   result.rawPoints,
          points:      result.points,
        });
      }
    }

    // ── PU entries ─────────────────────────────────────────────────────────

    const newPowerUnitEntries: any[] = [];

    for (const session of sessions) {
      const posMap = posMapForSession(session);

      // Build CarSessionData from all active drivers
      const carData: CarSessionData[] = [];
      for (const a of allAssets) {
        if (a.assetType !== 'driver') continue;
        const tSlug = a.teamSlug;
        const tName = TEAM_SLUG_TO_NAME[tSlug];
        if (!tName) continue;
        const manufacturer = POWER_UNIT_MAP[tName];
        if (!manufacturer) continue;
        const position = posMap.get(a.slug) ?? null;
        carData.push({ driverNumber: a.carNumber ?? 0, manufacturer, position });
      }

      const sessionScores = calculatePowerUnitSessionScores(carData, session);

      for (const score of sessionScores) {
        const slugs = puSlugsByManufacturer.get(score.manufacturer) ?? [];
        for (const puSlug of slugs) {
          newPowerUnitEntries.push({
            powerUnitSlug: puSlug,
            session,
            avgPosition:   score.avgPosition,
            rank:          score.rank,
            rawPoints:     score.rawPoints,
            points:        score.points,
          });
        }
      }
    }

    // ── Log preview ────────────────────────────────────────────────────────

    const principalTotals = new Map<string, number>();
    for (const e of newPrincipalEntries) {
      principalTotals.set(e.principalSlug, r2((principalTotals.get(e.principalSlug) ?? 0) + e.points));
    }
    console.log(`  Principal entries: ${newPrincipalEntries.length}`);
    for (const [slug, tot] of principalTotals) {
      console.log(`    ${slug.padEnd(36)} total=${tot}`);
    }

    const puTotals = new Map<string, number>();
    for (const e of newPowerUnitEntries) {
      puTotals.set(e.powerUnitSlug, r2((puTotals.get(e.powerUnitSlug) ?? 0) + e.points));
    }
    console.log(`  PU entries: ${newPowerUnitEntries.length}`);
    for (const [slug, tot] of puTotals) {
      console.log(`    ${slug.padEnd(36)} total=${tot}`);
    }

    // Accumulate for asset-totals computation (works in both dry-run and live)
    allNewPrincipalEntries.push(...newPrincipalEntries);
    allNewPowerUnitEntries.push(...newPowerUnitEntries);

    if (!DRY_RUN) {
      cal.principalResults  = newPrincipalEntries;
      cal.powerUnitResults  = newPowerUnitEntries;
      await cal.save();
      calUpdatedCount++;
    }
  }

  // ── Recompute Asset totals ─────────────────────────────────────────────────

  console.log('\n--- Recomputing Asset totals ---');

  // Sum from in-memory new entries — correct in both dry-run and live modes.
  const newTotals = new Map<string, number>();

  for (const e of allNewPrincipalEntries) {
    if (e.principalSlug) {
      newTotals.set(e.principalSlug, r2((newTotals.get(e.principalSlug) ?? 0) + (e.points ?? 0)));
    }
  }
  for (const e of allNewPowerUnitEntries) {
    if (e.powerUnitSlug) {
      newTotals.set(e.powerUnitSlug, r2((newTotals.get(e.powerUnitSlug) ?? 0) + (e.points ?? 0)));
    }
  }

  let assetUpdatedCount = 0;
  for (const a of [...principalAssets, ...puAssets]) {
    const newTotal = newTotals.get(a.slug) ?? 0;
    const oldTotal = oldTotals.get(a.slug) ?? 0;
    const racesCompleted: number = a.racesCompleted ?? 0;
    const newAvg = racesCompleted > 0 ? r2(newTotal / racesCompleted) : 0;
    console.log(`  ${a.slug.padEnd(40)} old=${oldTotal}  new=${newTotal}  avg=${newAvg}`);
    if (!DRY_RUN) {
      await Asset.updateOne(
        { _id: a._id },
        { $set: { totalPoints: newTotal, avgPointsPerRace: newAvg } },
      );
      assetUpdatedCount++;
    }
  }

  // ── Roster deltas ──────────────────────────────────────────────────────────

  console.log('\n--- Updating Roster totals ---');

  const rosters = await Roster.find({ season: 2026 })
    .populate('principalAssetId', 'slug')
    .populate('powerUnitAssetId', 'slug')
    .lean() as any[];

  let totalRosterDelta = 0;
  let rosterUpdatedCount = 0;

  for (const roster of rosters) {
    const pSlug  = roster.principalAssetId?.slug;
    const puSlug = roster.powerUnitAssetId?.slug;

    const pDelta  = pSlug  ? r2((newTotals.get(pSlug)  ?? 0) - (oldTotals.get(pSlug)  ?? 0)) : 0;
    const puDelta = puSlug ? r2((newTotals.get(puSlug) ?? 0) - (oldTotals.get(puSlug) ?? 0)) : 0;
    const delta   = r2(pDelta + puDelta);

    if (delta === 0) continue;

    const newRosterTotal = r2((roster.totalPoints ?? 0) + delta);
    totalRosterDelta += delta;
    rosterUpdatedCount++;

    console.log(`  roster ${roster._id}  pDelta=${pDelta}  puDelta=${puDelta}  total: ${roster.totalPoints} → ${newRosterTotal}`);

    if (!DRY_RUN) {
      await Roster.updateOne({ _id: roster._id }, { $set: { totalPoints: newRosterTotal } });
    }
  }

  // ── Re-rank within each league ─────────────────────────────────────────────

  console.log('\n--- Re-ranking rosters ---');

  const rosterDocs = DRY_RUN
    ? rosters.map(r => ({ ...r, totalPoints: r.totalPoints + (r._deltaApplied ?? 0) }))
    : (await Roster.find({ season: 2026 }).lean() as any[]);

  const byLeague = new Map<string, any[]>();
  for (const r of rosterDocs) {
    const lid = r.leagueId?.toString();
    if (!lid) continue;
    const arr = byLeague.get(lid) ?? [];
    arr.push(r);
    byLeague.set(lid, arr);
  }

  for (const [leagueId, leagueRosters] of byLeague) {
    leagueRosters.sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
    for (let i = 0; i < leagueRosters.length; i++) {
      const r = leagueRosters[i];
      const newRank = i + 1;
      if (r.seasonRank !== newRank) {
        if (!DRY_RUN) {
          await Roster.updateOne({ _id: r._id }, { $set: { seasonRank: newRank } });
        }
      }
    }
  }

  console.log(`  Re-ranked ${byLeague.size} leagues`);

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log('\n=== Done ===');
  console.log(`  Calendar entries updated: ${DRY_RUN ? '(dry run)' : calUpdatedCount}`);
  console.log(`  Assets updated:           ${DRY_RUN ? '(dry run)' : assetUpdatedCount}`);
  console.log(`  Rosters adjusted:         ${DRY_RUN ? '(dry run — ' + rosterUpdatedCount + ' would change)' : rosterUpdatedCount}`);
  console.log(`  Total roster point delta: ${r2(totalRosterDelta)}`);
  if (DRY_RUN) console.log('\nDRY RUN complete — no writes made.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
