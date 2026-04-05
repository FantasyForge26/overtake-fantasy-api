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
// Ranks are relative to all pit crews that race — 1 = best.
// rank 0 means the crew had no stops that race → 0 points.
// ---------------------------------------------------------------------------

export function calculatePitCrewScore(fastestStopRank: number, avgTimeRank: number): number {
  if (fastestStopRank === 0 && avgTimeRank === 0) return 0;
  return (FINISH_POINTS[fastestStopRank] ?? 0) + (FINISH_POINTS[avgTimeRank] ?? 0);
}

// ---------------------------------------------------------------------------
// Power unit score
// avgFinishRank = rank among all manufacturers by average finish position (1 = best).
// ---------------------------------------------------------------------------

export function calculatePowerUnitScore(avgFinishRank: number): number {
  return FINISH_POINTS[avgFinishRank] ?? 0;
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

interface AssetForOTF {
  otfBaseRating: number;
  racesCompleted: number;
  avgPointsPerRace: number;
  totalPoints: number;
  age?: number;
  teamStrength: number;
  dnfCount: number;
}

export function calculateOTFRating(asset: AssetForOTF): number {
  if (asset.racesCompleted === 0) return asset.otfBaseRating;

  const performanceScore = Math.min(asset.avgPointsPerRace * 5, 50);
  const volumeScore      = Math.min(asset.totalPoints / 500, 1) * 20;
  const ageBoost         = asset.age
    ? asset.age < 25 ? 8 : asset.age < 28 ? 5 : asset.age < 32 ? 2 : 0
    : 0;
  const teamBoost        = (asset.teamStrength / 100) * 10;
  const reliabilityScore =
    ((asset.racesCompleted - asset.dnfCount) / asset.racesCompleted) * 10;

  return Math.min(99, Math.max(1, Math.round(
    performanceScore + volumeScore + ageBoost + teamBoost + reliabilityScore,
  )));
}
