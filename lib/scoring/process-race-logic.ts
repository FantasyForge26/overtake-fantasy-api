/**
 * Shared race-processing logic used by both:
 *   - app/api/admin/process-race  (manual, POST with meetingKey)
 *   - app/api/cron/auto-process-race (automated, GET triggered by schedule)
 */

import { Asset, League, Roster, HistoricalSeason, ProcessedRace } from '@/lib/models';
import { buildRaceWeekendData } from '@/lib/scoring/openf1';
import { calculateRaceWeekendScores, PrincipalStreakState } from '@/lib/scoring/index';
import { calculateOTFRating } from '@/lib/otf-calculator';

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

/**
 * Core scoring function. Assumes DB is already connected.
 * Skips idempotency check — callers are responsible for checking ProcessedRace first.
 */
export async function processRace(meetingKey: number): Promise<ProcessRaceResult> {
  // 1. Build race weekend data from OpenF1
  const weekendData = await buildRaceWeekendData(meetingKey, POWER_UNIT_MAP);

  // Patch race name into the ProcessedRace lock if it exists
  await ProcessedRace.updateOne({ meetingKey }, { raceName: weekendData.raceName });

  // 2. Load principal streak states
  const principalAssets = await Asset.find({ season: 2026, assetType: 'principal', isActive: true }).lean() as any[];
  const streakStates: Record<string, PrincipalStreakState> = {};
  for (const pa of principalAssets) {
    streakStates[pa.team ?? pa.teamSlug] = {
      qualifyingStreak: pa.qualifyingStreak ?? 0,
      raceStreak:       pa.raceStreak ?? 0,
    };
  }

  // 3. Calculate all scores
  const { scores, newPrincipalStreakStates } = calculateRaceWeekendScores(weekendData, streakStates);

  // 4. Build lookup maps
  const driverScoreByNum = new Map<number, number>();
  for (const q of scores.qualifying) {
    driverScoreByNum.set(q.driverNumber, (driverScoreByNum.get(q.driverNumber) ?? 0) + q.total);
  }
  if (scores.sprint) {
    for (const s of scores.sprint) {
      driverScoreByNum.set(s.driverNumber, (driverScoreByNum.get(s.driverNumber) ?? 0) + s.total);
    }
  }
  for (const r of scores.race) {
    driverScoreByNum.set(r.driverNumber, (driverScoreByNum.get(r.driverNumber) ?? 0) + r.total);
  }

  const principalScoreByTeam = new Map<string, number>();
  for (const p of scores.principals) principalScoreByTeam.set(p.teamName, p.total);

  const pitCrewScoreByNum = new Map<number, number>();
  for (const pc of scores.pitCrews) pitCrewScoreByNum.set(pc.carNumber, pc.total);

  const puScoreByManufacturer = new Map<string, number>();
  for (const pu of scores.powerUnits) puScoreByManufacturer.set(pu.manufacturer, pu.points);

  // 5. Load all 2026 assets
  const allAssets: any[] = await Asset.find({ season: 2026, isActive: true }).lean();
  const assetById = new Map<string, any>(allAssets.map(a => [a._id.toString(), a]));

  // 5b. Build qualifying result lookup by driver number (for q-stage tracking)
  const qualByDriverNum = new Map<number, import('@/lib/scoring/qualifying').QualifyingDriverResult>();
  for (const qr of weekendData.qualifyingResults) {
    qualByDriverNum.set(qr.driverNumber, qr);
  }

  // 6. Score each league's rosters
  const activeLeagues = await League.find({ status: 'active' });
  let rostersUpdated = 0;
  const leagueSummaries: { leagueId: string; rostersScored: number }[] = [];

  for (const league of activeLeagues) {
    const leagueId = league._id.toString();
    const rosters  = await Roster.find({ leagueId, season: 2026 });
    if (!rosters.length) continue;

    let rostersScored = 0;

    for (const roster of rosters) {
      let racePoints = 0;

      const d1  = roster.driver1AssetId   ? assetById.get(roster.driver1AssetId.toString())   : null;
      const d2  = roster.driver2AssetId   ? assetById.get(roster.driver2AssetId.toString())   : null;
      const pr  = roster.principalAssetId ? assetById.get(roster.principalAssetId.toString()) : null;
      const pc1 = roster.pitCrew1AssetId  ? assetById.get(roster.pitCrew1AssetId.toString())  : null;
      const pc2 = roster.pitCrew2AssetId  ? assetById.get(roster.pitCrew2AssetId.toString())  : null;
      const pu  = roster.powerUnitAssetId ? assetById.get(roster.powerUnitAssetId.toString()) : null;

      if (d1?.carNumber)     racePoints += driverScoreByNum.get(d1.carNumber) ?? 0;
      if (d2?.carNumber)     racePoints += driverScoreByNum.get(d2.carNumber) ?? 0;
      if (pr?.team)          racePoints += principalScoreByTeam.get(pr.team) ?? 0;
      if (pc1) {
        const cn = pc1.carNumber ?? pitCrewCarNumber(pc1.slug ?? '');
        racePoints += pitCrewScoreByNum.get(cn) ?? 0;
      }
      if (pc2) {
        const cn = pc2.carNumber ?? pitCrewCarNumber(pc2.slug ?? '');
        racePoints += pitCrewScoreByNum.get(cn) ?? 0;
      }
      if (pu?.manufacturer)  racePoints += puScoreByManufacturer.get(pu.manufacturer) ?? 0;

      racePoints        = Math.round(racePoints * 100) / 100;
      roster.totalPoints = Math.round(((roster.totalPoints ?? 0) + racePoints) * 100) / 100;
      roster.updatedAt   = new Date();
      await roster.save();
      rostersScored++;
      rostersUpdated++;
    }

    // Refresh season ranks
    const ranked = [...rosters].sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
    for (let i = 0; i < ranked.length; i++) {
      ranked[i].seasonRank = i + 1;
      await ranked[i].save();
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
      await Asset.findByIdAndUpdate(asset._id, {
        $set: { totalPoints: newTotal, racesCompleted: newRaces, avgPointsPerRace: newAvg, otfRating: newOtfRating },
        ...(Object.keys(qInc).length ? { $inc: qInc } : {}),
      });
    } else {
      await Asset.findByIdAndUpdate(asset._id, {
        totalPoints:      newTotal,
        racesCompleted:   newRaces,
        avgPointsPerRace: newAvg,
        otfRating:        newOtfRating,
      });
    }

    assetUpdates.push(asset.slug);
  }

  // 8. Persist principal streak states
  for (const [teamName, newStreak] of Object.entries(newPrincipalStreakStates)) {
    await Asset.findOneAndUpdate(
      { season: 2026, assetType: 'principal', team: teamName },
      { $set: { qualifyingStreak: newStreak.qualifyingStreak, raceStreak: newStreak.raceStreak } },
    );
  }

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
