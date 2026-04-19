const SPRINT_POSITION_BONUS: Record<number, number> = {
   1: 6.23,  2: 5.98,  3: 5.70,  4: 5.43,  5: 5.16,
   6: 4.90,  7: 4.63,  8: 4.36,  9: 4.09, 10: 3.83,
  11: 3.56, 12: 3.29, 13: 3.03, 14: 2.76, 15: 2.49,
  16: 2.23, 17: 1.96, 18: 1.69, 19: 1.42, 20: 1.16,
  21: 0.89, 22: 0.62,
};

const FINISHED_BONUS       = 0.62;
const DSQ_PENALTY          = -3.56;
const POSITIONS_GAINED_PTS = 0.31;
const POSITIONS_LOST_PTS   = -0.08;

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
