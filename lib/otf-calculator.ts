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
  1:  27.00,
  2:  25.87,
  3:  24.62,
  4:  23.37,
  5:  22.12,
  6:  20.87,
  7:  19.62,
  8:  18.37,
  9:  17.12,
  10: 15.87,
  11: 14.62,
  12: 13.37,
  13: 12.12,
  14: 10.87,
  15:  9.62,
  16:  8.37,
  17:  7.12,
  18:  5.87,
  19:  4.62,
  20:  3.37,
  21:  2.12,
  22:  0.87,
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
  1:  27.00,
  2:  25.87,
  3:  24.62,
  4:  23.37,
  5:  22.12,
  6:  20.87,
  7:  19.62,
  8:  18.37,
  9:  17.12,
  10: 15.87,
  11: 14.62,
  12: 13.37,
  13: 12.12,
  14: 10.87,
  15:  9.62,
  16:  8.37,
  17:  7.12,
  18:  5.87,
  19:  4.62,
  20:  3.37,
  21:  2.12,
  22:  0.87,
};

// finishPositions = finish position of every car using that manufacturer this race.
// DNFs should be passed as 22. Average is rounded to nearest whole number, then
// looked up in PU_FINISH_POINTS.
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

interface HistoricalSeasonForOTF {
  season: number;
  wins: number;
  podiums: number;
  racesCompleted: number;
  q3Count: number;
  qualifyingRaces: number;
  dnfCount: number;
  avgPointsPerRace: number;
}

interface AssetForOTF {
  otfBaseRating: number;
  racesCompleted: number;
  avgPointsPerRace: number;
  totalPoints: number;
  age?: number;
  teamStrength: number;
  dnfCount: number;
  historicalSeasons?: HistoricalSeasonForOTF[];
}

function calculateHistoricalScore(historicalSeasons: HistoricalSeasonForOTF[]): number | null {
  if (!historicalSeasons.length) return null;

  const WEIGHTS: Record<number, number> = { 2025: 0.6, 2024: 0.4 };

  let weightedSum = 0;
  let totalWeight = 0;

  for (const s of historicalSeasons) {
    const weight = WEIGHTS[s.season];
    if (!weight) continue;

    const q3Rate     = s.qualifyingRaces > 0 ? s.q3Count / s.qualifyingRaces : 0;
    const seasonScore = Math.min(s.wins * 3 + s.podiums * 1.5 + q3Rate * 10, 20);

    weightedSum  += seasonScore * weight;
    totalWeight  += weight;
  }

  if (totalWeight === 0) return null;
  return weightedSum / totalWeight;
}

export function calculateOTFRating(asset: AssetForOTF): number {
  const historicalScore = asset.historicalSeasons?.length
    ? calculateHistoricalScore(asset.historicalSeasons)
    : null;

  if (asset.racesCompleted === 0) {
    if (historicalScore !== null) {
      // Scale historicalScore (0–20) to a 0–99 range via base rating anchor
      const blended = 0.4 * asset.otfBaseRating + 0.6 * (historicalScore * (99 / 20));
      return Math.min(99, Math.max(1, Math.round(blended)));
    }
    return asset.otfBaseRating;
  }

  const performanceScore = Math.min(asset.avgPointsPerRace * 5, 50);
  const volumeScore      = Math.min(asset.totalPoints / 500, 1) * 20;
  const ageBoost         = asset.age
    ? asset.age < 25 ? 8 : asset.age < 28 ? 5 : asset.age < 32 ? 2 : 0
    : 0;
  const teamBoost        = (asset.teamStrength / 100) * 10;
  const reliabilityScore =
    ((asset.racesCompleted - asset.dnfCount) / asset.racesCompleted) * 10;

  const currentScore = performanceScore + volumeScore + ageBoost + teamBoost + reliabilityScore;

  if (historicalScore !== null) {
    const scaledHistorical = historicalScore * (99 / 20);
    const blended = 0.7 * currentScore + 0.3 * scaledHistorical;
    return Math.min(99, Math.max(1, Math.round(blended)));
  }

  return Math.min(99, Math.max(1, Math.round(currentScore)));
}
