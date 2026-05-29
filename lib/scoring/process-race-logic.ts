/**
 * Shared race-processing logic used by both:
 *   - app/api/admin/process-race  (manual, POST with meetingKey)
 *   - app/api/cron/auto-process-race (automated, GET triggered by schedule)
 *
 * TRANSACTIONS (H7):
 *   Pass `options.session` to run all writes inside a Mongoose ClientSession
 *   so a mid-flight failure rolls everything back. Without this, a crash after
 *   N of M roster updates leaves partial state, the lock is released by the
 *   caller's catch block, and the next retry double-scores the first N.
 *
 *   Callers should:
 *     1. const session = await mongoose.startSession();
 *     2. await session.withTransaction(async () => {
 *          await ProcessedRace.create([{ meetingKey, raceName: null }], { session });
 *          result = await processRace(meetingKey, { session });
 *          // optional: also update RaceCalendar.processed here
 *        });
 *     3. await session.endSession();
 *     4. await recalculateAllOTFv2(2026);   // idempotent, outside the txn
 *
 *   recalculateAllOTFv2 is intentionally NOT included here — it's an
 *   idempotent full-table recompute that can be safely re-run via the
 *   admin endpoint if it fails. Pulling it into the transaction would
 *   double the lock window for no atomicity benefit.
 */

import type { ClientSession } from 'mongoose';
import { Asset, League, Roster, HistoricalSeason, ProcessedRace, RaceCalendar } from '@/lib/models';
import { buildRaceWeekendData } from '@/lib/scoring/openf1';
import { calculateRaceWeekendScores, PrincipalStreakState } from '@/lib/scoring/index';
import { calculateOTFRating } from '@/lib/otf-calculator';
import { loadBoostedSlots, isBoosted } from '@/lib/scoring/boost-helper';
import { calculatePrincipalSessionScore, SessionType as PrincipalSessionType } from '@/lib/scoring/principal-session';
import { calculatePowerUnitSessionScores, CarSessionData as PuCarSessionData } from '@/lib/scoring/powerunit-session';

export const POWER_UNIT_MAP: Record<string, string> = {
  'Red Bull Racing': 'Ford Red Bull Powertrains',
  'Racing Bulls':    'Ford Red Bull Powertrains',
  'Cadillac':        'General Motors',
  'Mercedes':        'Mercedes',
  'McLaren':         'Mercedes',
  'Williams':        'Mercedes',
  'Ferrari':         'Ferrari',
  'Haas':            'Ferrari',
  'Aston Martin':    'Honda',
  'Alpine':          'Renault',
  'Audi':            'Audi',
};

function pitCrewCarNumber(slug: string): number {
  const m = slug.match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

export interface ProcessRaceResult {
  success:       true;
  raceName:      string;
  meetingKey:    number;
  hasSprint:     boolean;
  assetsUpdated: number;
  rostersUpdated: number;
  leagues:       { leagueId: string; rostersScored: number }[];
}

export interface ProcessRaceOptions {
  /**
   * When provided, all DB reads and writes inside this function use the
   * given Mongoose ClientSession. Callers should obtain one via
   * `mongoose.startSession()` and wrap the call in `session.withTransaction()`.
   * Without it, behavior is unchanged from pre-H7.
   */
  session?: ClientSession;
}

/**
 * Core scoring function. Assumes DB is already connected.
 * Skips idempotency check — callers are responsible for checking ProcessedRace first.
 *
 * Pass `options.session` to participate in a caller-managed transaction.
 */
export async function processRace(
  meetingKey: number,
  options: ProcessRaceOptions = {},
): Promise<ProcessRaceResult> {
  const { session } = options;

  // 1. Build race weekend data from OpenF1 (external API, no session needed)
  const weekendData = await buildRaceWeekendData(meetingKey, POWER_UNIT_MAP);

  // Patch race name into the ProcessedRace lock if it exists
  await ProcessedRace.updateOne(
    { meetingKey },
    { raceName: weekendData.raceName },
    { session },
  );

  // Load calendar flags so we can skip sessions already scored by live crons
  const raceCalendar = await RaceCalendar.findOne({ meetingKey }).session(session ?? null).lean() as any;

  // 2. Load principal streak states
  const principalAssets = await Asset.find({ season: 2026, assetType: 'principal', isActive: true }).session(session ?? null).lean() as any[];
  const streakStates: Record<string, PrincipalStreakState> = {};
  for (const pa of principalAssets) {
    streakStates[pa.team ?? pa.teamSlug] = {
      qualifyingStreak: pa.qualifyingStreak ?? 0,
      raceStreak:       pa.raceStreak ?? 0,
    };
  }

  // 3. Calculate all scores
  const { scores, newPrincipalStreakStates } = calculateRaceWeekendScores(weekendData, streakStates);

  // 4. Load all 2026 assets (needed for per-session principal/PU scoring below)
  const allAssets: any[] = await Asset.find({ season: 2026, isActive: true }).session(session ?? null).lean();
  const assetById = new Map<string, any>(allAssets.map(a => [a._id.toString(), a]));

  // carNumber lookup for sprint quali position mapping (driverSlug → carNumber)
  const carNumByDriverSlug = new Map<string, number>();
  for (const a of allAssets) {
    if (a.assetType === 'driver' && a.carNumber) carNumByDriverSlug.set(a.slug, a.carNumber);
  }

  // ── Per-session principal + PU scoring ──────────────────────────────────────

  // Build teamName → [driverNumber, ...] and driverNumber → teamName from pitData
  const driversByTeamName = new Map<string, number[]>();
  for (const pd of weekendData.pitData) {
    const arr = driversByTeamName.get(pd.teamName) ?? [];
    arr.push(pd.driverNumber);
    driversByTeamName.set(pd.teamName, arr);
  }

  // Position maps (driverNumber → position | null) per session
  const qualiPosByNum = new Map<number, number | null>();
  for (const q of weekendData.qualifyingResults) {
    qualiPosByNum.set(q.driverNumber, q.finalPosition ?? null);
  }

  const racePosByNum = new Map<number, number | null>();
  for (const r of weekendData.raceResults) {
    racePosByNum.set(r.driverNumber, (r.status === 'DNF' || r.status === 'DSQ') ? null : (r.finishPosition ?? null));
  }

  const sprintRacePosByNum = new Map<number, number | null>();
  if (weekendData.hasSprint && (weekendData as any).sprintResults) {
    for (const s of (weekendData as any).sprintResults) {
      sprintRacePosByNum.set(s.driverNumber, s.finishPosition ?? null);
    }
  }

  // Sprint quali positions from raceCalendar (written by live cron before processRace runs)
  const sprintQualiPosByNum = new Map<number, number | null>();
  if (weekendData.hasSprint && raceCalendar?.sprintQualiResults) {
    for (const e of (raceCalendar.sprintQualiResults as any[])) {
      const cn = carNumByDriverSlug.get(e.driverSlug);
      if (cn != null) sprintQualiPosByNum.set(cn, e.position ?? null);
    }
  }

  const sessionList: PrincipalSessionType[] = weekendData.hasSprint
    ? ['sprintQuali', 'sprintRace', 'qualifying', 'race']
    : ['qualifying', 'race'];

  const posMapForSession = (s: PrincipalSessionType): Map<number, number | null> => {
    switch (s) {
      case 'sprintQuali': return sprintQualiPosByNum;
      case 'sprintRace':  return sprintRacePosByNum;
      case 'qualifying':  return qualiPosByNum;
      case 'race':        return racePosByNum;
    }
  };

  // principalSlug lookup: asset.team → principalSlug
  const principalSlugByTeamNameMap = new Map<string, string>();
  for (const a of allAssets) {
    if (a.assetType === 'principal' && a.team) principalSlugByTeamNameMap.set(a.team, a.slug);
  }

  // Compute per-session principal entries; build principalScoreByTeam for roster + asset scoring
  const sessionPrincipalEntries: any[] = [];
  const principalScoreByTeam = new Map<string, number>();

  for (const [teamName, driverNums] of driversByTeamName) {
    const principalSlug = principalSlugByTeamNameMap.get(teamName);
    if (!principalSlug) continue;
    for (const session of sessionList) {
      const posMap = posMapForSession(session);
      const result = calculatePrincipalSessionScore({
        teamName,
        driver1Position: driverNums[0] != null ? (posMap.get(driverNums[0]) ?? null) : null,
        driver2Position: driverNums[1] != null ? (posMap.get(driverNums[1]) ?? null) : null,
        session,
      });
      sessionPrincipalEntries.push({
        principalSlug,
        session,
        avgPosition: result.avgPosition,
        rawPoints:   result.rawPoints,
        points:      result.points,
      });
      principalScoreByTeam.set(teamName,
        Math.round(((principalScoreByTeam.get(teamName) ?? 0) + result.points) * 100) / 100,
      );
    }
  }

  // Compute per-session PU entries; build puScoreByManufacturer for roster + asset scoring
  const sessionPuEntries: any[] = [];
  const puScoreByManufacturer = new Map<string, number>();

  for (const session of sessionList) {
    const posMap = posMapForSession(session);
    const carData: PuCarSessionData[] = (weekendData.pitData as any[])
      .filter(pd => POWER_UNIT_MAP[pd.teamName])
      .map(pd => ({
        driverNumber: pd.driverNumber,
        manufacturer: POWER_UNIT_MAP[pd.teamName],
        position:     posMap.get(pd.driverNumber) ?? null,
      }));

    const sessionScores = calculatePowerUnitSessionScores(carData, session);

    for (const score of sessionScores) {
      const puAssets = allAssets.filter(a => a.assetType === 'powerUnit' && a.manufacturer === score.manufacturer);
      for (const puAsset of puAssets) {
        sessionPuEntries.push({
          powerUnitSlug: puAsset.slug,
          session,
          avgPosition:   score.avgPosition,
          rank:          score.rank,
          rawPoints:     score.rawPoints,
          points:        score.points,
        });
      }
      puScoreByManufacturer.set(score.manufacturer,
        Math.round(((puScoreByManufacturer.get(score.manufacturer) ?? 0) + score.points) * 100) / 100,
      );
    }
  }

  // 5. Build driver + pit crew lookup maps
  const driverScoreByNum = new Map<number, number>();

  // Skip qualifying if already scored live by score-main-quali cron (prevents double-scoring)
  if (raceCalendar?.qualifyingScored !== true) {
    for (const q of scores.qualifying) {
      driverScoreByNum.set(q.driverNumber, (driverScoreByNum.get(q.driverNumber) ?? 0) + q.total);
    }
  }

  // Skip sprint race if already scored live by score-sprint-race cron (prevents double-scoring)
  if (scores.sprint && raceCalendar?.sprintRaceScored !== true) {
    for (const s of scores.sprint) {
      driverScoreByNum.set(s.driverNumber, (driverScoreByNum.get(s.driverNumber) ?? 0) + s.total);
    }
  }

  for (const r of scores.race) {
    driverScoreByNum.set(r.driverNumber, (driverScoreByNum.get(r.driverNumber) ?? 0) + r.total);
  }

  const pitCrewScoreByNum = new Map<number, number>();
  for (const pc of scores.pitCrews) pitCrewScoreByNum.set(pc.carNumber, pc.total);

  // 5b. Build qualifying result lookup by driver number (for q-stage tracking)
  const qualByDriverNum = new Map<number, import('@/lib/scoring/qualifying').QualifyingDriverResult>();
  for (const qr of weekendData.qualifyingResults) {
    qualByDriverNum.set(qr.driverNumber, qr);
  }

  // 6. Score each league's rosters
  const activeLeagues = await League.find({ status: 'active' }).session(session ?? null);
  let rostersUpdated = 0;
  const leagueSummaries: { leagueId: string; rostersScored: number }[] = [];

  for (const league of activeLeagues) {
    const leagueId = league._id.toString();
    const rosters  = await Roster.find({ leagueId, season: 2026 }).session(session ?? null);
    if (!rosters.length) continue;

    // Load locked boost selections for this league + round.
    // raceCalendar may be null for old meetings without a calendar entry — use round 0 (yields empty boosts, safe no-op).
    const boosts = await loadBoostedSlots(leagueId, raceCalendar?.round ?? 0, 2026);

    let rostersScored = 0;

    for (const roster of rosters) {
      const rosterId = roster._id.toString();
      let racePoints = 0;

      const d1  = roster.driver1AssetId   ? assetById.get(roster.driver1AssetId.toString())   : null;
      const d2  = roster.driver2AssetId   ? assetById.get(roster.driver2AssetId.toString())   : null;
      const pr  = roster.principalAssetId ? assetById.get(roster.principalAssetId.toString()) : null;
      const pc1 = roster.pitCrew1AssetId  ? assetById.get(roster.pitCrew1AssetId.toString())  : null;
      const pc2 = roster.pitCrew2AssetId  ? assetById.get(roster.pitCrew2AssetId.toString())  : null;
      const pu  = roster.powerUnitAssetId ? assetById.get(roster.powerUnitAssetId.toString()) : null;

      // Drivers: boost multiplier applies (driver1Boost / driver2Boost)
      const d1Mult = d1?.slug && isBoosted(boosts, rosterId, d1.slug) ? 2 : 1;
      const d2Mult = d2?.slug && isBoosted(boosts, rosterId, d2.slug) ? 2 : 1;
      if (d1?.carNumber) racePoints += (driverScoreByNum.get(d1.carNumber) ?? 0) * d1Mult;
      if (d2?.carNumber) racePoints += (driverScoreByNum.get(d2.carNumber) ?? 0) * d2Mult;

      // Principal: NOT boostable — no multiplier
      if (pr?.team) racePoints += principalScoreByTeam.get(pr.team) ?? 0;

      // Pit crews: boost multiplier applies (pitCrew1Boost / pitCrew2Boost)
      if (pc1) {
        const cn = pc1.carNumber ?? pitCrewCarNumber(pc1.slug ?? '');
        const mult = pc1.slug && isBoosted(boosts, rosterId, pc1.slug) ? 2 : 1;
        racePoints += (pitCrewScoreByNum.get(cn) ?? 0) * mult;
      }
      if (pc2) {
        const cn = pc2.carNumber ?? pitCrewCarNumber(pc2.slug ?? '');
        const mult = pc2.slug && isBoosted(boosts, rosterId, pc2.slug) ? 2 : 1;
        racePoints += (pitCrewScoreByNum.get(cn) ?? 0) * mult;
      }

      // Power unit: NOT boostable — no multiplier
      if (pu?.manufacturer) racePoints += puScoreByManufacturer.get(pu.manufacturer) ?? 0;

      racePoints        = Math.round(racePoints * 100) / 100;
      roster.totalPoints = Math.round(((roster.totalPoints ?? 0) + racePoints) * 100) / 100;
      roster.updatedAt   = new Date();
      await roster.save({ session });
      rostersScored++;
      rostersUpdated++;
    }

    // Refresh season ranks
    const ranked = [...rosters].sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
    for (let i = 0; i < ranked.length; i++) {
      ranked[i].seasonRank = i + 1;
      await ranked[i].save({ session });
    }

    leagueSummaries.push({ leagueId, rostersScored });
  }

  // 7. Update global asset stats + OTF ratings
  const assetUpdates: string[] = [];

  for (const asset of allAssets) {
    let score  = 0;
    let scored = false;

    if (asset.assetType === 'driver' && asset.carNumber) {
      score  = driverScoreByNum.get(asset.carNumber) ?? 0;
      scored = driverScoreByNum.has(asset.carNumber);
    } else if (asset.assetType === 'principal' && asset.team) {
      score  = principalScoreByTeam.get(asset.team) ?? 0;
      scored = principalScoreByTeam.has(asset.team);
    } else if (asset.assetType === 'pitCrew') {
      const cn = asset.carNumber ?? pitCrewCarNumber(asset.slug ?? '');
      score  = pitCrewScoreByNum.get(cn) ?? 0;
      scored = pitCrewScoreByNum.has(cn);
    } else if (asset.assetType === 'powerUnit' && asset.manufacturer) {
      score  = puScoreByManufacturer.get(asset.manufacturer) ?? 0;
      scored = puScoreByManufacturer.has(asset.manufacturer);
    }

    if (!scored) continue;

    const newTotal = Math.round(((asset.totalPoints ?? 0) + score) * 100) / 100;
    const newRaces = (asset.racesCompleted ?? 0) + 1;
    const newAvg   = Math.round((newTotal / newRaces) * 100) / 100;

    const historicalDocs = await HistoricalSeason.find({ assetSlug: asset.slug }).session(session ?? null).lean() as any[];
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

    const newOtfRating = calculateOTFRating({
      otfBaseRating:    asset.otfBaseRating ?? 50,
      racesCompleted:   newRaces,
      avgPointsPerRace: newAvg,
      totalPoints:      newTotal,
      age:              asset.age,
      teamStrength:     asset.teamStrength ?? 50,
      dnfCount:         asset.dnfCount ?? 0,
      assetType:        asset.assetType,
      championshipWins: asset.championshipWins,
      historicalSeasons,
    });

    // For drivers, also track qualifying stage counts
    if (asset.assetType === 'driver' && asset.carNumber) {
      const qr = qualByDriverNum.get(asset.carNumber);
      const qInc: Record<string, number> = {};
      if (qr) {
        qInc.qualifyingRaces = 1;
        if (qr.reachedQ3)       qInc.q3Count = 1;
        else if (qr.reachedQ2)  qInc.q2Count = 1;
      }
      await Asset.findByIdAndUpdate(
        asset._id,
        {
          $set: { totalPoints: newTotal, racesCompleted: newRaces, avgPointsPerRace: newAvg, otfRating: newOtfRating },
          ...(Object.keys(qInc).length ? { $inc: qInc } : {}),
        },
        { session },
      );
    } else {
      await Asset.findByIdAndUpdate(
        asset._id,
        {
          totalPoints:      newTotal,
          racesCompleted:   newRaces,
          avgPointsPerRace: newAvg,
          otfRating:        newOtfRating,
        },
        { session },
      );
    }

    assetUpdates.push(asset.slug);
  }

  // 8. Persist principal streak states
  for (const [teamName, newStreak] of Object.entries(newPrincipalStreakStates)) {
    await Asset.findOneAndUpdate(
      { season: 2026, assetType: 'principal', team: teamName },
      { $set: { qualifyingStreak: newStreak.qualifyingStreak, raceStreak: newStreak.raceStreak } },
      { session },
    );
  }

  // 9. Persist per-asset weekend breakdown to RaceCalendar
  if (raceCalendar) {
    // Build driver + pit crew slug maps from already-loaded allAssets
    const driverSlugByCarNum  = new Map<number, string>();
    const pitCrewSlugByCarNum = new Map<number, string>();

    for (const a of allAssets) {
      if (a.assetType === 'driver' && a.carNumber) driverSlugByCarNum.set(a.carNumber, a.slug);
      if (a.assetType === 'pitCrew') {
        const cn = a.carNumber ?? pitCrewCarNumber(a.slug ?? '');
        if (cn) pitCrewSlugByCarNum.set(cn, a.slug);
      }
    }

    // Race results: race-day points only (not qualifying or sprint — those have their own arrays)
    const raceScoreByNum = new Map<number, number>(scores.race.map(r => [r.driverNumber, r.total]));
    const raceResultsForCal = weekendData.raceResults
      .filter(r => driverSlugByCarNum.has(r.driverNumber))
      .map(r => ({
        driverSlug:    driverSlugByCarNum.get(r.driverNumber)!,
        position:      r.finishPosition ?? null,
        startPosition: r.startPosition,
        points:        Math.round((raceScoreByNum.get(r.driverNumber) ?? 0) * 100) / 100,
        fastestLap:    r.fastestLap,
        notClassified: r.status === 'DNF',
        dsq:           r.status === 'DSQ',
      }))
      .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));

    // principalResults: per-session entries computed above (replaces old single-entry per round)
    const principalResultsForCal = sessionPrincipalEntries;

    const pitCrewResultsForCal = scores.pitCrews
      .filter(p => pitCrewSlugByCarNum.has(p.carNumber))
      .map(p => ({
        pitCrewSlug:       pitCrewSlugByCarNum.get(p.carNumber)!,
        points:            Math.round(p.total * 100) / 100,
        stopCount:         p.stopCount,
        avgStopTime:       p.avgStopTime,
        fastestStop:       p.fastestStop,
        wasOverallFastest: p.wasOverallFastest,
      }));

    // powerUnitResults: per-session entries computed above (replaces old single-entry per round)
    const powerUnitResultsForCal = sessionPuEntries;

    await RaceCalendar.findOneAndUpdate(
      { _id: (raceCalendar as any)._id },
      { $set: {
          processed:        true,
          processedAt:      new Date(),
          raceResults:      raceResultsForCal,
          principalResults: principalResultsForCal,
          pitCrewResults:   pitCrewResultsForCal,
          powerUnitResults: powerUnitResultsForCal,
        },
      },
      { session },
    );
  }

  // NOTE: OTFv2 recalc (recalculateAllOTFv2) is intentionally NOT done here.
  // It's an idempotent full-table recompute and runs as a separate post-
  // transaction step in the caller. See file-level docstring.

  return {
    success:        true,
    raceName:       scores.raceName,
    meetingKey,
    hasSprint:      weekendData.hasSprint,
    assetsUpdated:  assetUpdates.length,
    rostersUpdated,
    leagues:        leagueSummaries,
  };
}
