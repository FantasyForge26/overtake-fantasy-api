const QUALIFYING_POSITION_BONUS: Record<number, number> = {
   1: 7.57,  2: 7.23,  3: 6.88,  4: 6.54,  5: 6.19,
   6: 5.85,  7: 5.50,  8: 5.16,  9: 4.81, 10: 4.47,
  11: 4.12, 12: 3.78, 13: 3.43, 14: 3.09, 15: 2.75,
  16: 2.40, 17: 2.06, 18: 1.72, 19: 1.37, 20: 1.03,
  21: 0.69, 22: 0.34,
};

const Q2_BONUS            =  0.76;
const Q3_BONUS            =  1.51;
const TEAMMATE_BEAT_BONUS =  0.76;
const DNQ_PENALTY         = -1.51;
const DSQ_PENALTY         = -2.27;

export interface QualifyingDriverResult {
  driverNumber:  number;
  teamName:      string;
  finalPosition: number | null; // null if DNQ
  reachedQ2:     boolean;
  reachedQ3:     boolean;
  setLapTime:    boolean;
  status:        'Qualified' | 'DNQ' | 'DSQ';
}

export interface QualifyingDriverScore {
  driverNumber:      number;
  positionBonus:     number;
  q1Bonus:           number; // reaching Q2
  q2Bonus:           number; // reaching Q3
  teammateBeatBonus: number;
  dnqPenalty:        number;
  dsqPenalty:        number;
  total:             number;
}

export function calculateQualifyingDriverScore(
  result: QualifyingDriverResult,
  allResults: QualifyingDriverResult[],
): QualifyingDriverScore {
  const zero: QualifyingDriverScore = {
    driverNumber:      result.driverNumber,
    positionBonus:     0,
    q1Bonus:           0,
    q2Bonus:           0,
    teammateBeatBonus: 0,
    dnqPenalty:        0,
    dsqPenalty:        0,
    total:             0,
  };

  if (result.status === 'DSQ') {
    return { ...zero, dsqPenalty: DSQ_PENALTY, total: DSQ_PENALTY };
  }

  if (result.status === 'DNQ' || !result.setLapTime) {
    return { ...zero, dnqPenalty: DNQ_PENALTY, total: DNQ_PENALTY };
  }

  const positionBonus = result.finalPosition != null
    ? (QUALIFYING_POSITION_BONUS[result.finalPosition] ?? 0)
    : 0;

  const q1Bonus = result.reachedQ2 ? Q2_BONUS : 0;
  const q2Bonus = result.reachedQ3 ? Q3_BONUS : 0;

  // Teammate comparison: find other driver on same team, compare finalPosition
  const teammate = allResults.find(
    r => r.teamName === result.teamName && r.driverNumber !== result.driverNumber,
  );
  const aheadOfTeammate =
    result.finalPosition != null &&
    (teammate == null ||
      teammate.finalPosition == null ||
      result.finalPosition < teammate.finalPosition);
  const teammateBeatBonus = aheadOfTeammate ? TEAMMATE_BEAT_BONUS : 0;

  const total = Math.round(
    (positionBonus + q1Bonus + q2Bonus + teammateBeatBonus) * 100
  ) / 100;

  return {
    driverNumber: result.driverNumber,
    positionBonus,
    q1Bonus,
    q2Bonus,
    teammateBeatBonus,
    dnqPenalty: 0,
    dsqPenalty: 0,
    total,
  };
}

export function calculateAllQualifyingDriverScores(
  results: QualifyingDriverResult[],
): QualifyingDriverScore[] {
  return results.map(r => calculateQualifyingDriverScore(r, results));
}
