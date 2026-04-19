const SPRINT_POSITION_BONUS: Record<number, number> = {
   1: 9.54,  2: 9.14,  3: 8.73,  4: 8.32,  5: 7.90,
   6: 7.51,  7: 7.09,  8: 6.68,  9: 6.26, 10: 5.87,
  11: 5.45, 12: 5.04, 13: 4.63, 14: 4.23, 15: 3.82,
  16: 3.42, 17: 3.01, 18: 2.59, 19: 2.18, 20: 1.78,
  21: 1.37, 22: 0.95,
};

const FINISHED_BONUS       =  0.95;
const DSQ_PENALTY          = -5.45;
const POSITIONS_GAINED_PTS =  0.47;
const POSITIONS_LOST_PTS   = -0.13;

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
