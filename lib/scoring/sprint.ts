const SPRINT_POSITION_BONUS: Record<number, number> = {
   1: 5.60,  2: 5.36,  3: 5.12,  4: 4.88,  5: 4.64,
   6: 4.40,  7: 4.16,  8: 3.92,  9: 3.68, 10: 3.44,
  11: 3.20, 12: 2.96, 13: 2.72, 14: 2.48, 15: 2.24,
  16: 2.00, 17: 1.76, 18: 1.52, 19: 1.28, 20: 1.04,
  21: 0.80, 22: 0.56,
};

const FINISHED_BONUS       = 0.56;
const DSQ_PENALTY          = -3.20;
const POSITIONS_GAINED_PTS = 0.28;
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
