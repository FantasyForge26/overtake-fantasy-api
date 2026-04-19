const RACE_POSITION_BONUS: Record<number, number> = {
   1: 20.00,  2: 19.09,  3: 18.18,  4: 17.27,  5: 16.36,
   6: 15.46,  7: 14.55,  8: 13.64,  9: 12.73, 10: 11.82,
  11: 10.91, 12: 10.00, 13:  9.09, 14:  8.18, 15:  7.27,
  16:  6.36, 17:  5.45, 18:  4.55, 19:  3.64, 20:  2.73,
  21:  1.82, 22:  0.91,
};

const FINISHED_BONUS          =  1.46;
const POSITIONS_GAINED_PTS    =  0.73;
const POSITIONS_LOST_PTS      = -0.18;
const TEAMMATE_BEAT_BONUS     =  1.82;
const FASTEST_LAP_BONUS       =  4.00;
const TOP10_CROSSOVER_BONUS   =  0.36;
const TOP10_CROSSOVER_PENALTY = -0.36;
const DSQ_PENALTY             = -7.27;

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
