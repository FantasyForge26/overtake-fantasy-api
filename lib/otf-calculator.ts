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

// ---------------------------------------------------------------------------
// Driver score
// ---------------------------------------------------------------------------

export interface DriverScoreInput {
  finishPosition: number;
  startPosition: number;
  teammateFinishPosition: number;
  fastestLap: boolean;
  speedTrapViolation: boolean;
  notClassified: boolean;
  dnf: boolean;
  penalizedSeconds: number;
}

export function calculateDriverScore(input: DriverScoreInput): number {
  if (input.dnf || input.notClassified) return 0;

  const basePoints = FINISH_POINTS[input.finishPosition] ?? 0;

  // Positions gained vs grid start
  const positionsGained = input.startPosition - input.finishPosition;
  const positionsScore = positionsGained * 0.5;

  // Beat teammate bonus
  const beatTeammate = input.finishPosition < input.teammateFinishPosition ? 3 : 0;

  // Fastest lap bonus
  const fastestLapBonus = input.fastestLap ? 5 : 0;

  // Speed trap violation penalty
  const speedTrapPenalty = input.speedTrapViolation ? -5 : 0;

  // Time penalties (1 point per 5 seconds)
  const timePenalty = input.penalizedSeconds > 0 ? -(input.penalizedSeconds / 5) : 0;

  return Math.max(0, basePoints + positionsScore + beatTeammate + fastestLapBonus + speedTrapPenalty + timePenalty);
}

// ---------------------------------------------------------------------------
// Power unit score
// ---------------------------------------------------------------------------

export function calculatePowerUnitScore(avgFinishPosition: number): number {
  return (21 - avgFinishPosition) * 0.75;
}

// ---------------------------------------------------------------------------
// Pit crew score
// ---------------------------------------------------------------------------

export function calculatePitCrewScore(stopTimes: number[], fastestStopOverall: boolean): number {
  if (stopTimes.length === 0) return 0;

  const avg = stopTimes.reduce((sum, t) => sum + t, 0) / stopTimes.length;

  let baseScore: number;
  if      (avg < 2.2) baseScore = 25;
  else if (avg < 2.4) baseScore = 20;
  else if (avg < 2.6) baseScore = 17.5;
  else if (avg < 2.8) baseScore = 15;
  else if (avg < 3.0) baseScore = 12.5;
  else if (avg < 3.5) baseScore = 10;
  else if (avg < 4.0) baseScore = 7.5;
  else                baseScore = 5;

  const fastestBonus = fastestStopOverall ? 5 : 0;

  return baseScore + fastestBonus;
}

// ---------------------------------------------------------------------------
// Principal score
// ---------------------------------------------------------------------------

export function calculatePrincipalScore(driver1FinishPosition: number, driver2FinishPosition: number): number {
  const d1Points = FINISH_POINTS[driver1FinishPosition] ?? 0;
  const d2Points = FINISH_POINTS[driver2FinishPosition] ?? 0;
  return d1Points + d2Points;
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
  const volumeScore = Math.min(asset.totalPoints / 500, 1) * 20;
  const ageBoost = asset.age
    ? asset.age < 25 ? 8 : asset.age < 28 ? 5 : asset.age < 32 ? 2 : 0
    : 0;
  const teamBoost = (asset.teamStrength / 100) * 10;
  const reliabilityScore =
    ((asset.racesCompleted - asset.dnfCount) / asset.racesCompleted) * 10;

  return Math.min(99, Math.max(1, Math.round(
    performanceScore + volumeScore + ageBoost + teamBoost + reliabilityScore,
  )));
}
