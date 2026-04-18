const QUALIFYING_STREAK_BONUS = 5.00;
const RACE_STREAK_BONUS       = 7.50;
const STREAK_LENGTH           = 3;

// Combined place ranges from 2 (both P1) to 44 (both P22/DNF).
// Formula: 25 - ((combinedPlace - 2) * (24.75 / 42)), floored at 0.
function combinedPlaceBonus(combinedPlace: number): number {
  const pts = 25 - ((combinedPlace - 2) * (24.75 / 42));
  return Math.round(Math.max(0, pts) * 100) / 100;
}

export interface PrincipalRaceResult {
  teamName:                 string;
  driver1FinishPosition:    number | null; // null = DNF
  driver2FinishPosition:    number | null; // null = DNF
  driver1QualifyingPosition: number | null; // null = DNQ
  driver2QualifyingPosition: number | null; // null = DNQ
}

export interface PrincipalScore {
  teamName:               string;
  combinedFinishPosition: number;
  positionBonus:          number;
  qualifyingStreakBonus:  number;
  raceStreakBonus:        number;
  total:                  number;
}

export interface PrincipalStreakState {
  qualifyingStreak: number;
  raceStreak:       number;
}

export function calculatePrincipalScore(
  result: PrincipalRaceResult,
  streakState: PrincipalStreakState,
): { score: PrincipalScore; newStreakState: PrincipalStreakState } {
  // DNF = 22 for scoring purposes
  const d1Finish = result.driver1FinishPosition ?? 22;
  const d2Finish = result.driver2FinishPosition ?? 22;
  const combinedFinishPosition = d1Finish + d2Finish;
  const positionBonus = combinedPlaceBonus(combinedFinishPosition);

  // Qualifying streak: both drivers must finish top 10 in qualifying
  const bothQualTop10 =
    result.driver1QualifyingPosition != null && result.driver1QualifyingPosition <= 10 &&
    result.driver2QualifyingPosition != null && result.driver2QualifyingPosition <= 10;

  const incrementedQualStreak = bothQualTop10 ? streakState.qualifyingStreak + 1 : 0;
  const qualifyingStreakBonus = incrementedQualStreak === STREAK_LENGTH ? QUALIFYING_STREAK_BONUS : 0;
  const newQualStreak = incrementedQualStreak === STREAK_LENGTH ? 0 : incrementedQualStreak;

  // Race streak: both drivers must finish top 10 in the race
  const bothRaceTop10 =
    result.driver1FinishPosition != null && result.driver1FinishPosition <= 10 &&
    result.driver2FinishPosition != null && result.driver2FinishPosition <= 10;

  const incrementedRaceStreak = bothRaceTop10 ? streakState.raceStreak + 1 : 0;
  const raceStreakBonus = incrementedRaceStreak === STREAK_LENGTH ? RACE_STREAK_BONUS : 0;
  const newRaceStreak = incrementedRaceStreak === STREAK_LENGTH ? 0 : incrementedRaceStreak;

  const total = Math.round((positionBonus + qualifyingStreakBonus + raceStreakBonus) * 100) / 100;

  return {
    score: {
      teamName: result.teamName,
      combinedFinishPosition,
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
