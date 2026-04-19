const SPRINT_POSITION_BONUS: Record<number, number> = {
   1: 5.30,  2: 5.08,  3: 4.85,  4: 4.62,  5: 4.39,
   6: 4.17,  7: 3.94,  8: 3.71,  9: 3.48, 10: 3.26,
  11: 3.03, 12: 2.80, 13: 2.57, 14: 2.35, 15: 2.12,
  16: 1.90, 17: 1.67, 18: 1.44, 19: 1.21, 20: 0.99,
  21: 0.76, 22: 0.53,
};

const FINISHED_BONUS       = 0.53;
const DSQ_PENALTY          = -3.03;
const POSITIONS_GAINED_PTS = 0.26;
const POSITIONS_LOST_PTS   = -0.07;

export interface SprintResult {
  driverNumber:  number;
  finishPosition: number | null; // null if DNF
  startPosition: number;
  status:        'Finished' | 'DNF' | 'DSQ';
}

export interface SprintScore {
  driverNumber:         number;
  positionBonus:        number;
  finishedBonus:        number;
  positionsGainedBonus: number;
  positionsLostPenalty: number;
  dsqPenalty:           number;
  total:                number;
}

export function calculateSprintScore(result: SprintResult): SprintScore {
  const zero: SprintScore = {
    driverNumber:         result.driverNumber,
    positionBonus:        0,
    finishedBonus:        0,
    positionsGainedBonus: 0,
    positionsLostPenalty: 0,
    dsqPenalty:           0,
    total:                0,
  };

  if (result.status === 'DSQ') {
    return { ...zero, dsqPenalty: DSQ_PENALTY, total: DSQ_PENALTY };
  }

  if (result.status === 'DNF' || result.finishPosition == null) {
    return zero;
  }

  const positionBonus = SPRINT_POSITION_BONUS[result.finishPosition] ?? 0;
  const finishedBonus = FINISHED_BONUS;

  const delta = result.startPosition - result.finishPosition;
  const positionsGainedBonus = delta > 0 ? Math.round(delta * POSITIONS_GAINED_PTS * 100) / 100 : 0;
  const positionsLostPenalty = delta < 0 ? Math.round(delta * POSITIONS_LOST_PTS * 100) / 100 : 0;

  const total = Math.round(
    (positionBonus + finishedBonus + positionsGainedBonus + positionsLostPenalty) * 100
  ) / 100;

  return {
    driverNumber: result.driverNumber,
    positionBonus,
    finishedBonus,
    positionsGainedBonus,
    positionsLostPenalty,
    dsqPenalty: 0,
    total,
  };
}

export function calculateAllSprintScores(results: SprintResult[]): SprintScore[] {
  return results.map(calculateSprintScore);
}
