const QUALIFYING_STREAK_BONUS = 5.00;
const RACE_STREAK_BONUS       = 7.50;
const STREAK_LENGTH           = 3;

// Combined rank ranges from 1 (both P1, both pit crew rank 1) to 22.
// Formula: 70 - ((rank - 1) * (69.3 / 21)), floored at 0.
const PRINCIPAL_POSITION_BONUS: Record<number, number> = {
   1: 70.00,  2: 66.70,  3: 63.30,  4: 60.00,  5: 56.70,
   6: 53.30,  7: 50.00,  8: 46.70,  9: 43.30, 10: 40.00,
  11: 36.70, 12: 33.30, 13: 30.00, 14: 26.70, 15: 23.30,
  16: 20.00, 17: 16.70, 18: 13.30, 19: 10.00, 20:  6.70,
  21:  3.30, 22:  0.70,
};

export interface PrincipalRaceResult {
  teamName:                  string;
  driver1FinishPosition:     number | null; // null = DNF → scored as 22
  driver2FinishPosition:     number | null; // null = DNF → scored as 22
  driver1QualifyingPosition: number | null; // null = DNQ
  driver2QualifyingPosition: number | null; // null = DNQ
  pitCrew1AvgStopRank:       number | null; // null = no stops → scored as 22
  pitCrew2AvgStopRank:       number | null; // null = no stops → scored as 22
}

export interface PrincipalScore {
  teamName:              string;
  driverAvgPosition:     number;
  pitCrewAvgRank:        number;
  combinedRank:          number;
  positionBonus:         number;
  qualifyingStreakBonus: number;
  raceStreakBonus:       number;
  total:                 number;
}

export interface PrincipalStreakState {
  qualifyingStreak: number;
  raceStreak:       number;
}

export function calculatePrincipalScore(
  result: PrincipalRaceResult,
  streakState: PrincipalStreakState,
): { score: PrincipalScore; newStreakState: PrincipalStreakState } {
  // Driver component: avg finish position (DNF → 22)
  const d1Finish = result.driver1FinishPosition ?? 22;
  const d2Finish = result.driver2FinishPosition ?? 22;
  const driverAvgPosition = (d1Finish + d2Finish) / 2;

  // Pit crew component: avg stop rank (no stops → 22)
  const pc1Rank = result.pitCrew1AvgStopRank != null && result.pitCrew1AvgStopRank > 0
    ? result.pitCrew1AvgStopRank
    : 22;
  const pc2Rank = result.pitCrew2AvgStopRank != null && result.pitCrew2AvgStopRank > 0
    ? result.pitCrew2AvgStopRank
    : 22;
  const pitCrewAvgRank = (pc1Rank + pc2Rank) / 2;

  // Combined rank: average of driver avg and pit crew avg, rounded to nearest integer
  const combinedRank = Math.min(22, Math.max(1, Math.round((driverAvgPosition + pitCrewAvgRank) / 2)));

  const positionBonus = PRINCIPAL_POSITION_BONUS[combinedRank] ?? 0.35;

  // Qualifying streak: both drivers must finish top 10 in qualifying
  const bothQualTop10 =
    result.driver1QualifyingPosition != null && result.driver1QualifyingPosition <= 10 &&
    result.driver2QualifyingPosition != null && result.driver2QualifyingPosition <= 10;

  const incrementedQualStreak = bothQualTop10 ? streakState.qualifyingStreak + 1 : 0;
  const qualifyingStreakBonus  = incrementedQualStreak === STREAK_LENGTH ? QUALIFYING_STREAK_BONUS : 0;
  const newQualStreak          = incrementedQualStreak === STREAK_LENGTH ? 0 : incrementedQualStreak;

  // Race streak: both drivers must finish top 10 in the race
  const bothRaceTop10 =
    result.driver1FinishPosition != null && result.driver1FinishPosition <= 10 &&
    result.driver2FinishPosition != null && result.driver2FinishPosition <= 10;

  const incrementedRaceStreak = bothRaceTop10 ? streakState.raceStreak + 1 : 0;
  const raceStreakBonus        = incrementedRaceStreak === STREAK_LENGTH ? RACE_STREAK_BONUS : 0;
  const newRaceStreak          = incrementedRaceStreak === STREAK_LENGTH ? 0 : incrementedRaceStreak;

  const total = Math.round((positionBonus + qualifyingStreakBonus + raceStreakBonus) * 100) / 100;

  return {
    score: {
      teamName: result.teamName,
      driverAvgPosition: Math.round(driverAvgPosition * 100) / 100,
      pitCrewAvgRank:    Math.round(pitCrewAvgRank * 100) / 100,
      combinedRank,
      positionBonus,
      qualifyingStreakBonus,
      raceStreakBonus,
      total,
    },
    newStreakState: {
      qualifyingStreak: newQualStreak,
      raceStreak:       newRaceStreak,
    },
  };
}

export function calculateAllPrincipalScores(
  results: PrincipalRaceResult[],
  streakStates: Record<string, PrincipalStreakState>,
): { scores: PrincipalScore[]; newStreakStates: Record<string, PrincipalStreakState> } {
  const scores: PrincipalScore[] = [];
  const newStreakStates: Record<string, PrincipalStreakState> = { ...streakStates };

  for (const result of results) {
    const currentStreak = streakStates[result.teamName] ?? { qualifyingStreak: 0, raceStreak: 0 };
    const { score, newStreakState } = calculatePrincipalScore(result, currentStreak);
    scores.push(score);
    newStreakStates[result.teamName] = newStreakState;
  }

  return { scores, newStreakStates };
}
