const QUALIFYING_POSITION_BONUS: Record<number, number> = {
   1: 10.00,  2:  9.55,  3:  9.09,  4:  8.64,  5:  8.18,
   6:  7.73,  7:  7.27,  8:  6.82,  9:  6.36, 10:  5.91,
  11:  5.45, 12:  5.00, 13:  4.55, 14:  4.09, 15:  3.64,
  16:  3.18, 17:  2.73, 18:  2.27, 19:  1.82, 20:  1.36,
  21:  0.91, 22:  0.45,
};

const Q2_BONUS            =  1;
const Q3_BONUS            =  2;
const TEAMMATE_BEAT_BONUS =  1;
const DNQ_PENALTY         = -2;
const DSQ_PENALTY         = -3;

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
