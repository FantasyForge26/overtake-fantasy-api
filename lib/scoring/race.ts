const RACE_POSITION_BONUS: Record<number, number> = {
   1: 22.25,  2: 21.23,  3: 20.23,  4: 19.21,  5: 18.20,
   6: 17.19,  7: 16.18,  8: 15.17,  9: 14.16, 10: 13.15,
  11: 12.14, 12: 11.13, 13: 10.11, 14:  9.10, 15:  8.09,
  16:  7.08, 17:  6.07, 18:  5.06, 19:  4.05, 20:  3.03,
  21:  2.02, 22:  1.01,
};

const FINISHED_BONUS          =  1.62;
const POSITIONS_GAINED_PTS    =  0.81;
const POSITIONS_LOST_PTS      = -0.20;
const TEAMMATE_BEAT_BONUS     =  2.02;
const FASTEST_LAP_BONUS       =  4.45;
const TOP10_CROSSOVER_BONUS   =  0.40;
const TOP10_CROSSOVER_PENALTY = -0.40;
const DSQ_PENALTY             = -8.09;

export interface RaceDriverResult {
  driverNumber:   number;
  teamName:       string;
  finishPosition: number | null; // null if DNF
  startPosition:  number;
  status:         'Finished' | 'DNF' | 'DSQ';
  fastestLap:     boolean;
}

export interface RaceDriverScore {
  driverNumber:        number;
  positionBonus:       number;
  finishedBonus:       number;
  positionsGainedBonus: number;
  positionsLostPenalty: number;
  teammateBeatBonus:   number;
  fastestLapBonus:     number;
  top10BonusPenalty:   number;
  dsqPenalty:          number;
  total:               number;
}

export function calculateRaceDriverScore(
  result: RaceDriverResult,
  allResults: RaceDriverResult[],
): RaceDriverScore {
  const zero: RaceDriverScore = {
    driverNumber:         result.driverNumber,
    positionBonus:        0,
    finishedBonus:        0,
    positionsGainedBonus: 0,
    positionsLostPenalty: 0,
    teammateBeatBonus:    0,
    fastestLapBonus:      0,
    top10BonusPenalty:    0,
    dsqPenalty:           0,
    total:                0,
  };

  if (result.status === 'DSQ') {
    return { ...zero, dsqPenalty: DSQ_PENALTY, total: DSQ_PENALTY };
  }

  if (result.status === 'DNF' || result.finishPosition == null) {
    return zero;
  }

  const positionBonus = RACE_POSITION_BONUS[result.finishPosition] ?? 0;
  const finishedBonus = FINISHED_BONUS;

  const delta = result.startPosition - result.finishPosition;
  const positionsGainedBonus = delta > 0 ? Math.round(delta * POSITIONS_GAINED_PTS * 100) / 100 : 0;
  const positionsLostPenalty = delta < 0 ? Math.round(delta * Math.abs(POSITIONS_LOST_PTS) * 100) / 100 * -1 : 0;

  // Teammate beat bonus
  const teammate = allResults.find(
    r => r.teamName === result.teamName && r.driverNumber !== result.driverNumber,
  );
  const aheadOfTeammate =
    teammate == null ||
    teammate.finishPosition == null ||
    result.finishPosition < teammate.finishPosition;
  const teammateBeatBonus = aheadOfTeammate ? TEAMMATE_BEAT_BONUS : 0;

  const fastestLapBonus = result.fastestLap ? FASTEST_LAP_BONUS : 0;

  // Top 10 crossover bonus/penalty
  const startedTop10   = result.startPosition  <= 10;
  const finishedTop10  = result.finishPosition <= 10;
  let top10BonusPenalty = 0;
  if (!startedTop10 && finishedTop10)  top10BonusPenalty = TOP10_CROSSOVER_BONUS;
  if (startedTop10  && !finishedTop10) top10BonusPenalty = TOP10_CROSSOVER_PENALTY;

  const total = Math.round(
    (positionBonus +
      finishedBonus +
      positionsGainedBonus +
      positionsLostPenalty +
      teammateBeatBonus +
      fastestLapBonus +
      top10BonusPenalty) * 100
  ) / 100;

  return {
    driverNumber: result.driverNumber,
    positionBonus,
    finishedBonus,
    positionsGainedBonus,
    positionsLostPenalty,
    teammateBeatBonus,
    fastestLapBonus,
    top10BonusPenalty,
    dsqPenalty: 0,
    total,
  };
}

export function calculateAllRaceDriverScores(
  results: RaceDriverResult[],
): RaceDriverScore[] {
  return results.map(r => calculateRaceDriverScore(r, results));
}
