const QUALIFYING_POSITION_BONUS: Record<number, number> = {
   1: 13.63,  2: 13.01,  3: 12.38,  4: 11.77,  5: 11.14,
   6: 10.53,  7:  9.90,  8:  9.29,  9:  8.66, 10:  8.05,
  11:  7.42, 12:  6.80, 13:  6.17, 14:  5.56, 15:  4.95,
  16:  4.32, 17:  3.71, 18:  3.10, 19:  2.47, 20:  1.85,
  21:  1.24, 22:  0.61,
};

const Q2_BONUS            =  1.37;
const Q3_BONUS            =  2.72;
const TEAMMATE_BEAT_BONUS =  1.37;
const DNQ_PENALTY         = -2.72;
const DSQ_PENALTY         = -4.09;

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
