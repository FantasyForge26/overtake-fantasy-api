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
// Driver sprint qualifying score
// ---------------------------------------------------------------------------

/**
 * Sprint Qualifying score — position-based, half of main qualifying rate.
 * Formula: max(0, 8 - 0.5 * position)
 * P1=7.5, P2=7.0, P3=6.5 ... P15=0.5, P16-P20=0
 * Plus pole bonus of 0.25 (half of the 0.5 pt P1→P2 delta in main qualifying).
 */
export function calculateDriverSprintQualifyingScore(
  sprintQualiPosition: number | null | undefined,
): number {
  if (sprintQualiPosition == null || sprintQualiPosition < 1 || sprintQualiPosition > 20) return 0;
  const positionPts = Math.max(0, 8 - 0.5 * sprintQualiPosition);
  const poleBonus   = sprintQualiPosition === 1 ? 0.25 : 0;
  return Math.round((positionPts + poleBonus) * 100) / 100;
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

// Asset-type ceilings — hierarchy: Driver > Principal > Pit Crew > Power Unit
const OTF_CEILING: Record<string, number> = {
  driver:    99,
  principal: 85,
  pitCrew:   83,
  powerUnit: 75,
};

// Performance score: piecewise linear interpolation over empirical anchor points
function performanceScore(
  avgPointsPerRace: number,
  assetType: 'driver' | 'principal' | 'pitCrew' | 'powerUnit',
): number {
  // Tightened driver curve 2026-05-10: ceiling reachable at avg ≥ 60 pts/race
  // (down from 75). Realistic single-race max is ~70 with all bonuses, so 75
  // avg required no real driver to ever hit ceiling. 60 avg = consistent
  // poles + wins, which is what we actually want to recognise.
  const anchors: Record<string, [number, number][]> = {
    driver:    [[0, 30], [10, 50], [20, 65], [30, 78], [40, 88], [50, 95], [60, 99]],
    principal: [[0, 30], [10, 50], [25, 70], [40, 80], [55, 85]],
    pitCrew:   [[0, 30], [10, 50], [25, 70], [35, 80], [45, 83]],
    powerUnit: [[0, 30], [5, 50], [10, 65], [15, 72], [20, 75]],
  };

  const pts = anchors[assetType];
  if (avgPointsPerRace <= pts[0][0]) return pts[0][1];
  if (avgPointsPerRace >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];

  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    if (avgPointsPerRace >= x1 && avgPointsPerRace <= x2) {
      const ratio = (avgPointsPerRace - x1) / (x2 - x1);
      return y1 + ratio * (y2 - y1);
    }
  }
  return pts[pts.length - 1][1];
}

function seasonNormalisedScore(s: HistoricalSeasonForOTF, assetType: string): number {
  return performanceScore(
    s.avgPointsPerRace,
    assetType as 'driver' | 'principal' | 'pitCrew' | 'powerUnit',
  );
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

export function calculateOTFRating(asset: AssetForOTF): number {
  const assetType = (asset.assetType ?? 'driver') as 'driver' | 'principal' | 'pitCrew' | 'powerUnit';
  const ceiling   = OTF_CEILING[assetType] ?? 99;

  // Historical score — past seasons only (2023/2024/2025)
  const pastSeasons = (asset.historicalSeasons ?? []).filter(s => s.season < 2026);
  const historicalScore = pastSeasons.length
    ? calculateHistoricalWeightedScore(pastSeasons, assetType)
    : null;

  const races = asset.racesCompleted;
  const perfScore = performanceScore(asset.avgPointsPerRace, assetType);
  const baseScore = asset.otfBaseRating; // already 0-100, do not re-curve

  // Weights by race count: [wPerf, wHist, wBase].
  //
  // Tuned 2026-05-10 to bias more aggressively toward current-season
  // performance so auto-draft picks the asset who's actually scoring now,
  // not the one with the best preseason guess. Pre-season tier (0 races)
  // still leans on baseRating since there's no data yet, but it nudges
  // historical up slightly to break ties between same-base assets.
  let wPerf: number, wHist: number, wBase: number;

  if (races === 0) {
    wPerf = 0.00; wHist = 0.30; wBase = 0.70;
  } else if (races <= 2) {
    wPerf = 0.50; wHist = 0.25; wBase = 0.25;
  } else if (races <= 5) {
    wPerf = 0.75; wHist = 0.20; wBase = 0.05;
  } else if (races <= 15) {
    wPerf = 0.85; wHist = 0.12; wBase = 0.03;
  } else {
    wPerf = 0.92; wHist = 0.06; wBase = 0.02;
  }

  // Sparse-history correction: a rookie's 1 partial historical season is
  // noisy data that shouldn't drag down a current-season hot streak. Count
  // how many seasons have meaningful sample size (≥5 races), then scale
  // wHist down accordingly and give the freed weight to current perf.
  const usableHistCount = pastSeasons.filter(s => s.racesCompleted >= 5).length;
  let effectiveWHist = wHist;
  if (historicalScore === null || usableHistCount === 0) {
    // No usable history at all — redirect hist weight to current perf
    // (was: redirected to base, which penalised over-performing rookies).
    wPerf += wHist;
    effectiveWHist = 0;
  } else if (usableHistCount === 1) {
    // Only 1 usable hist season — reduce hist weight to 25% of normal,
    // give the freed 75% to perf so a hot rookie can climb.
    const cut = wHist * 0.75;
    wPerf += cut;
    effectiveWHist = wHist - cut;
  }

  let rating: number;
  if (effectiveWHist > 0 && historicalScore !== null) {
    rating = wPerf * perfScore + effectiveWHist * historicalScore + wBase * baseScore;
  } else {
    rating = wPerf * perfScore + wBase * baseScore;
  }

  return Math.round(Math.min(rating, ceiling));
}
