const QUALIFYING_POSITION_BONUS: Record<number, number> = {
   1: 8.00,  2: 7.64,  3: 7.27,  4: 6.91,  5: 6.55,
   6: 6.18,  7: 5.82,  8: 5.45,  9: 5.09, 10: 4.73,
  11: 4.36, 12: 4.00, 13: 3.64, 14: 3.27, 15: 2.91,
  16: 2.55, 17: 2.18, 18: 1.82, 19: 1.45, 20: 1.09,
  21: 0.73, 22: 0.36,
};

const Q2_BONUS            =  0.80;
const Q3_BONUS            =  1.60;
const TEAMMATE_BEAT_BONUS =  0.80;
const DNQ_PENALTY         = -1.60;
const DSQ_PENALTY         = -2.40;

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
