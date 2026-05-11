/**
 * /api/assets/[slug]/rating-history
 *
 * Returns the OTF rating timeline for an asset, split into two series:
 *
 *   current[]    — one point per round of the current season. For each round
 *                  N, computes calculateOTFv2 using ONLY race data from rounds
 *                  1..N-1, so the value at round N is what the rating WAS
 *                  BEFORE the round-N race weekend. This makes the line a
 *                  faithful "if I drafted at the start of this round, this is
 *                  what the asset looked like" view.
 *
 *   historical[] — one point per past season + the current rating. Past-season
 *                  ratings are derived from HistoricalSeason.avgPointsPerRace
 *                  via the same performance curve, treating each year as a
 *                  standalone snapshot.
 *
 * Response shape:
 *   {
 *     assetSlug, assetType,
 *     current:    [ { round, raceName, rating } ],
 *     historical: [ { season, rating } ]
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { Asset, HistoricalSeason, RaceCalendar } from '@/lib/models';
import { calculateOTFv2, type PerRaceRowForOTF } from '@/lib/otf-calculator';

const SEASON = 2026;

// Re-implement the per-race row builders from scripts/recalculate-otf-v2.ts
// (small enough to inline; keeps this endpoint self-contained).

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

function buildAllRows(calendars: any[], asset: any): PerRaceRowForOTF[] {
  switch (asset.assetType) {
    case 'driver':    return rowsForDriver(calendars, asset.slug);
    case 'principal': return rowsForPrincipal(calendars, asset.slug);
    case 'pitCrew':   return rowsForPitCrew(calendars, asset.slug);
    case 'powerUnit': return rowsForPowerUnit(calendars, asset.slug);
    default:          return [];
  }
}

// Coarse end-of-season rating derived from a single historical season —
// pipes the season's avgPointsPerRace through the same performance curve via
// calculateOTFv2 by treating the season as the "current" data.
function endOfSeasonRating(season: any, asset: any): number {
  // Fake a single per-race row equal to the season's avg so PERF/FORM both
  // map to the same curve value. CONS defaults to 70 (single-point), HIST
  // uses the asset's actual historical seasons filtered to before this year.
  const fakeRow: PerRaceRowForOTF = { round: 1, total: season.avgPointsPerRace ?? 0 };
  const { rating } = calculateOTFv2({
    assetType:        asset.assetType,
    otfBaseRating:    asset.otfBaseRating ?? 50,
    perRaceRows:      [fakeRow],
    historicalSeasons: [], // standalone snapshot for that year
  });
  return rating;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { slug } = await params;

  await connectDB();

  const asset = await Asset.findOne({ slug, season: SEASON }).lean() as any;
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const [calendars, historicalSeasonDocs] = await Promise.all([
    RaceCalendar.find({ season: SEASON }).sort({ round: 1 }).lean() as any,
    HistoricalSeason.find({ assetSlug: slug }).sort({ season: 1 }).lean() as any,
  ]);

  const processedCals = (calendars as any[]).filter(c => (c.raceResults ?? []).length > 0);

  const allRows = buildAllRows(processedCals, asset);

  // Map historical docs to common shape calculateOTFv2 expects
  const historicalSeasons = historicalSeasonDocs.map((h: any) => ({
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

  // ── CURRENT timeline ────────────────────────────────────────────────────
  // For each processed round, compute the rating BEFORE that round (using
  // only race data from earlier rounds). Plus a "before R1" preseason point
  // anchored to the asset's base rating.
  const current: Array<{ round: number; raceName: string; rating: number }> = [];

  // Pre-season anchor — show what the rating would have been before any 2026 races
  if (processedCals.length > 0) {
    const { rating } = calculateOTFv2({
      assetType:        asset.assetType,
      otfBaseRating:    asset.otfBaseRating ?? 50,
      perRaceRows:      [],
      historicalSeasons,
    });
    current.push({ round: 0, raceName: 'Preseason', rating });
  }

  for (const cal of processedCals) {
    const priorRows = allRows.filter(r => r.round < cal.round);
    const { rating } = calculateOTFv2({
      assetType:        asset.assetType,
      otfBaseRating:    asset.otfBaseRating ?? 50,
      perRaceRows:      priorRows,
      historicalSeasons,
    });
    current.push({
      round:    cal.round,
      raceName: cal.country ?? `R${cal.round}`,
      rating,
    });
  }

  // Also push a "now" point reflecting the full season-to-date — i.e. AFTER
  // the most recent race.
  if (allRows.length > 0) {
    const { rating } = calculateOTFv2({
      assetType:        asset.assetType,
      otfBaseRating:    asset.otfBaseRating ?? 50,
      perRaceRows:      allRows,
      historicalSeasons,
    });
    current.push({
      round:    (processedCals[processedCals.length - 1]?.round ?? 0) + 0.5,
      raceName: 'Now',
      rating,
    });
  }

  // ── HISTORICAL timeline ──────────────────────────────────────────────────
  // One point per past season + a final point for current 2026.
  const historical: Array<{ season: number; rating: number }> = [];
  for (const h of historicalSeasonDocs.sort((a: any, b: any) => a.season - b.season)) {
    if (h.season >= SEASON) continue;
    historical.push({ season: h.season, rating: endOfSeasonRating(h, asset) });
  }
  // Current season point uses live composite rating
  historical.push({ season: SEASON, rating: asset.otfRating ?? 50 });

  return NextResponse.json({
    assetSlug: slug,
    assetType: asset.assetType,
    current,
    historical,
  });
}
