// ---------------------------------------------------------------------------
// Points tables
// ---------------------------------------------------------------------------

export const FINISH_POINTS: Record<number, number> = {
  1:  25,
  2:  23.75,
  3:  22.50,
  4:  21.25,
  5:  20,
  6:  18.75,
  7:  17.50,
  8:  16.25,
  9:  15,
  10: 13.75,
  11: 12.50,
  12: 11.25,
  13: 10,
  14: 8.75,
  15: 7.50,
  16: 6.25,
  17: 5,
  18: 3.75,
  19: 2.50,
  20: 1.25,
  21: 0.75,
  22: 0.25,
};

export const QUALIFYING_POSITION_POINTS: Record<number, number> = {
  1:  10,
  2:  9.5,
  3:  9.0,
  4:  8.5,
  5:  8.0,
  6:  7.5,
  7:  7.0,
  8:  6.5,
  9:  6.0,
  10: 5.5,
  11: 5.0,
  12: 4.5,
  13: 4.0,
  14: 3.5,
  15: 3.0,
  16: 2.5,
  17: 2.0,
  18: 1.5,
  19: 1.0,
  20: 0.5,
};

// Top 10 only; positions 11+ score 0
export const SPRINT_POSITION_POINTS: Record<number, number> = {
  1: 10, 2: 9, 3: 8, 4: 7, 5: 6,
  6:  5, 7: 4, 8: 3, 9: 2, 10: 1,
};

// ---------------------------------------------------------------------------
// Driver qualifying score
// ---------------------------------------------------------------------------

export interface DriverQualifyingScoreInput {
  qualifyingPosition: number;
  qualifyingRound: 'Q1' | 'Q2' | 'Q3';
  beatenTeammate: boolean;
  didNotQualify: boolean;
  dsqFromQualifying: boolean;
}

export function calculateDriverQualifyingScore(input: DriverQualifyingScoreInput): number {
  if (input.dsqFromQualifying) return -10;
  if (input.didNotQualify)     return -5;

  const roundBonus = input.qualifyingRound === 'Q3' ? 3
                   : input.qualifyingRound === 'Q2' ? 2
                   : 1;
  const positionBonus  = QUALIFYING_POSITION_POINTS[input.qualifyingPosition] ?? 0;
  const teammateBonus  = input.beatenTeammate ? 2 : 0;

  return roundBonus + positionBonus + teammateBonus;
}

// ---------------------------------------------------------------------------
// Driver race score
// ---------------------------------------------------------------------------

export interface DriverRaceScoreInput {
  finishPosition: number;
  startPosition: number;
  teammateFinishPosition: number;
  fastestLap: boolean;
  notClassified: boolean;
  dsq: boolean;
  startedInTop10: boolean;
}

export function calculateDriverRaceScore(input: DriverRaceScoreInput): number {
  if (input.dsq)           return -20;
  if (input.notClassified) return -15;

  const basePoints    = FINISH_POINTS[input.finishPosition] ?? 0;
  const finishBonus   = 1;
  const teammateBonus = input.finishPosition < input.teammateFinishPosition ? 3 : 0;
  const fastestBonus  = input.fastestLap ? 5 : 0;

  const delta = input.startPosition - input.finishPosition;
  let positionScore = 0;
  if (delta > 0) {
    positionScore = Math.min(delta * 2, 10);
  } else if (delta < 0) {
    const lostPlaces = -delta;
    positionScore = input.startedInTop10
      ? -Math.min(lostPlaces * 2, 10)
      : -Math.min(lostPlaces * 1, 5);
  }

  return basePoints + finishBonus + teammateBonus + fastestBonus + positionScore;
}

// ---------------------------------------------------------------------------
// Driver sprint score
// ---------------------------------------------------------------------------

export interface DriverSprintScoreInput {
  finishPosition: number;
  startPosition: number;
  teammateFinishPosition: number;
  fastestLap: boolean;
  notClassified: boolean;
  dsq: boolean;
}

export function calculateDriverSprintScore(input: DriverSprintScoreInput): number {
  if (input.dsq)           return -10;
  if (input.notClassified) return -5;

  const sprintBonus   = SPRINT_POSITION_POINTS[input.finishPosition] ?? 0;
  const finishBonus   = 1;
  const teammateBonus = input.finishPosition < input.teammateFinishPosition ? 2 : 0;
  const fastestBonus  = input.fastestLap ? 3 : 0;

  const delta = input.startPosition - input.finishPosition;
  let positionScore = 0;
  if (delta > 0) {
    positionScore = Math.min(delta, 5);
  } else if (delta < 0) {
    positionScore = Math.max(delta, -5);
  }

  return sprintBonus + finishBonus + teammateBonus + fastestBonus + positionScore;
}

// ---------------------------------------------------------------------------
// Pit crew score
// Separate points table matching PU_FINISH_POINTS — covers ranks 1–22.
// Ranks are relative to all pit crews that race — 1 = best.
// rank 0 means the crew had no stops that race → 0 points.
// ---------------------------------------------------------------------------

export const PIT_CREW_POINTS: Record<number, number> = {
  1:  25.00,  2:  23.75,  3:  22.50,  4:  21.25,  5:  20.00,
  6:  18.75,  7:  17.50,  8:  16.25,  9:  15.00, 10:  13.75,
  11: 12.50, 12:  11.25, 13:  10.00, 14:   8.75, 15:   7.50,
  16:  6.25, 17:   5.00, 18:   3.75, 19:   2.50, 20:   1.25,
  21:  0.75, 22:   0.25,
};

export function calculatePitCrewScore(fastestStopRank: number, avgTimeRank: number): number {
  if (fastestStopRank === 0 && avgTimeRank === 0) return 0;
  return (PIT_CREW_POINTS[fastestStopRank] ?? 0) + (PIT_CREW_POINTS[avgTimeRank] ?? 0);
}

// ---------------------------------------------------------------------------
// Power unit score
// Separate points table with finer granularity — rewards manufacturer
// consistency across all supplied cars (positions 1–22, DNF = 22).
// ---------------------------------------------------------------------------

export const PU_FINISH_POINTS: Record<number, number> = {
  1:  25.00,  2:  23.75,  3:  22.50,  4:  21.25,  5:  20.00,
  6:  18.75,  7:  17.50,  8:  16.25,  9:  15.00, 10:  13.75,
  11: 12.50, 12:  11.25, 13:  10.00, 14:   8.75, 15:   7.50,
  16:  6.25, 17:   5.00, 18:   3.75, 19:   2.50, 20:   1.25,
  21:  0.75, 22:   0.25,
};

// finishPositions = finish position of every car using that manufacturer this race.
// DNFs should be passed as 22 (P22 = 0.25 pts). Average is rounded to nearest whole number,
// then looked up in PU_FINISH_POINTS.
export function calculatePowerUnitScore(finishPositions: number[]): number {
  if (finishPositions.length === 0) return 0;
  const avg = finishPositions.reduce((a, b) => a + b, 0) / finishPositions.length;
  return PU_FINISH_POINTS[Math.round(avg)] ?? 0;
}

// ---------------------------------------------------------------------------
// Principal score
// ---------------------------------------------------------------------------

export function calculatePrincipalScore(driver1FinishPosition: number, driver2FinishPosition: number): number {
  return (FINISH_POINTS[driver1FinishPosition] ?? 0) + (FINISH_POINTS[driver2FinishPosition] ?? 0);
}

// ---------------------------------------------------------------------------
// OTF rating recalculation (season-long rolling rating)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OTF tier labels and colours
// ---------------------------------------------------------------------------

export const OTF_TIER = (rating: number): { label: string; color: string } =>
  rating >= 90 ? { label: 'Elite',   color: '#FFD600' } :
  rating >= 75 ? { label: 'Strong',  color: '#A6FF00' } :
  rating >= 55 ? { label: 'Average', color: '#00D1FF' } :
  rating >= 35 ? { label: 'Risky',   color: '#FF8C00' } :
                 { label: 'Weak',    color: '#FF2D2D' };

// ---------------------------------------------------------------------------
// OTF rating (redesigned)
// ---------------------------------------------------------------------------

export interface HistoricalSeasonForOTF {
  season: number;
  wins: number;
  podiums: number;
  racesCompleted: number;
  q3Count: number;
  qualifyingRaces: number;
  dnfCount: number;
  avgPointsPerRace: number;
  championshipWins?: number;
}

export interface AssetForOTF {
  otfBaseRating: number;
  racesCompleted: number;
  avgPointsPerRace: number;
  totalPoints: number;
  age?: number;
  teamStrength: number;
  dnfCount: number;
  historicalSeasons?: HistoricalSeasonForOTF[];
  assetType?: 'driver' | 'pitCrew' | 'powerUnit' | 'principal';
  championshipWins?: number;
}

// Historical season weights — excludes 2026 (current season handled separately)
const SEASON_WEIGHTS: Record<number, number> = { 2025: 0.50, 2024: 0.30, 2023: 0.20 };

// Max realistic avgPointsPerRace per asset type (used to normalise to 0-100)
const MAX_PTS_PER_RACE: Record<string, number> = {
  driver:    25,
  pitCrew:   50,
  powerUnit: 25,
  principal: 50,
};

function seasonNormalisedScore(s: HistoricalSeasonForOTF, assetType: string): number {
  const maxPts = MAX_PTS_PER_RACE[assetType] ?? 30;
  const baseScore = Math.min((s.avgPointsPerRace / maxPts) * 100, 100);

  if (assetType === 'driver') {
    const winsBonus = Math.min(s.wins * 5, 20);
    const q3Rate    = s.qualifyingRaces > 0 ? s.q3Count / s.qualifyingRaces : 0;
    const q3Bonus   = q3Rate * 10;
    return Math.min(baseScore + winsBonus + q3Bonus, 100);
  }

  return baseScore;
}

function calculateHistoricalWeightedScore(
  historicalSeasons: HistoricalSeasonForOTF[],
  assetType: string,
): number | null {
  if (!historicalSeasons.length) return null;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const s of historicalSeasons) {
    const weight = SEASON_WEIGHTS[s.season];
    if (!weight || s.racesCompleted === 0) continue;

    const score = seasonNormalisedScore(s, assetType);
    weightedSum += score * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;
  return weightedSum / totalWeight;
}

function calculateChampionBonus(asset: AssetForOTF): number {
  // +2 per WDC/WCC win in historical seasons, capped at +8
  const seasonWins = (asset.historicalSeasons ?? [])
    .reduce((sum, s) => sum + (s.championshipWins ?? 0), 0);
  const seasonBonus = Math.min(seasonWins * 2, 8);

  // +1.5 per career championship win on the asset, capped at +6
  const careerBonus = Math.min((asset.championshipWins ?? 0) * 1.5, 6);

  return Math.min(seasonBonus + careerBonus, 10);
}

export function calculateOTFRating(asset: AssetForOTF): number {
  const assetType     = asset.assetType ?? 'driver';
  const maxPtsPerRace = MAX_PTS_PER_RACE[assetType] ?? 25;

  // Historical score only uses past seasons (2023/2024/2025), not current 2026
  const pastSeasons = (asset.historicalSeasons ?? []).filter(s => s.season < 2026);
  const historicalScore = pastSeasons.length
    ? calculateHistoricalWeightedScore(pastSeasons, assetType)
    : null;

  const championBonus = calculateChampionBonus(asset);

  let rating: number;
  const hasCurrentData = asset.racesCompleted >= 2;

  if (!hasCurrentData) {
    // Fewer than 2 races — treat as no current season data
    if (historicalScore !== null) {
      rating = 0.60 * asset.otfBaseRating + 0.40 * historicalScore;
    } else {
      rating = asset.otfBaseRating;
    }
  } else {
    const currentSeasonScore = Math.min((asset.avgPointsPerRace / maxPtsPerRace) * 100, 100);
    const races = asset.racesCompleted;

    let wBase: number, wHistorical: number, wCurrent: number;

    if (races <= 5) {
      wBase       = 0.60;
      wHistorical = 0.25;
      wCurrent    = 0.15;
    } else if (races <= 12) {
      wBase       = 0.40;
      wHistorical = 0.30;
      wCurrent    = 0.30;
    } else {
      wBase       = 0.20;
      wHistorical = 0.30;
      wCurrent    = 0.50;
    }

    if (historicalScore !== null) {
      rating = wBase * asset.otfBaseRating
             + wHistorical * historicalScore
             + wCurrent * currentSeasonScore;
    } else {
      rating = (wBase + wHistorical) * asset.otfBaseRating
             + wCurrent * currentSeasonScore;
    }

    // Overperformance / underperformance adjustment (requires ≥2 races)
    if (asset.racesCompleted >= 2) {
      const actualCurrentScore = Math.min((asset.avgPointsPerRace / maxPtsPerRace) * 100, 100);
      const delta = actualCurrentScore - asset.otfBaseRating;
      if (delta > 10) {
        rating += Math.min(delta * 0.3, 8);
      } else if (delta < -10) {
        rating += Math.max(delta * 0.2, -6);
      }
    }
  }

  // Historical data cannot push rating more than 6 points above otfBaseRating
  rating = Math.min(rating, asset.otfBaseRating + 6);

  return Math.min(99, Math.max(1, Math.round(rating + championBonus)));
}
