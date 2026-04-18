const SPRINT_POSITION_BONUS: Record<number, number> = {
   1: 7.00,  2: 6.70,  3: 6.40,  4: 6.10,  5: 5.80,
   6: 5.50,  7: 5.20,  8: 4.90,  9: 4.60, 10: 4.30,
  11: 4.00, 12: 3.70, 13: 3.40, 14: 3.10, 15: 2.80,
  16: 2.50, 17: 2.20, 18: 1.90, 19: 1.60, 20: 1.30,
  21: 1.00, 22: 0.70,
};

const FINISHED_BONUS       = 0.70;
const DSQ_PENALTY          = -4;
const POSITIONS_GAINED_PTS = 0.35;
const POSITIONS_LOST_PTS   = -0.09;

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
