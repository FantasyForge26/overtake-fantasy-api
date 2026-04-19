const QUALIFYING_STREAK_BONUS = 7.50;
const RACE_STREAK_BONUS       = 11.25;
const STREAK_LENGTH           = 3;
const DRIVER_COMPONENT_SCALE  = 0.65;

const PIT_CREW_AVG_RANK_BONUS: Record<number, number> = {
   1: 14.00,  2: 13.34,  3: 12.67,  4: 12.01,  5: 11.35,
   6: 10.68,  7: 10.02,  8:  9.34,  9:  8.68, 10:  8.02,
  11:  7.35, 12:  6.69, 13:  6.03, 14:  5.35, 15:  4.69,
  16:  4.02, 17:  3.36, 18:  2.70, 19:  2.03, 20:  1.37,
  21:  0.71, 22:  0.28,
};

export interface PrincipalRaceResult {
  teamName:                  string;
  driver1WeeklyPoints:       number; // total qual + sprint + race points for driver 1
  driver2WeeklyPoints:       number; // total qual + sprint + race points for driver 2
  driver1QualifyingPosition: number | null;
  driver2QualifyingPosition: number | null;
  driver1FinishPosition:     number | null; // null = DNF — used for streak check only
  driver2FinishPosition:     number | null;
  pitCrew1AvgStopRank:       number | null; // null / 0 = no stops → scored as 22
  pitCrew2AvgStopRank:       number | null;
}

export interface PrincipalScore {
  teamName:              string;
  driverAvgPoints:       number;
  pitCrewAvgRank:        number;
  pitCrewBonus:          number;
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
  // Driver component: average of both drivers' weekly fantasy points
  const rawAvg = (result.driver1WeeklyPoints + result.driver2WeeklyPoints) / 2;
  const driverAvgPoints =
    Math.floor(rawAvg * DRIVER_COMPONENT_SCALE * 100) / 100;

  // Pit crew component: floor average of the two crews' avg stop ranks (no stops → 22)
  const pc1Rank = result.pitCrew1AvgStopRank != null && result.pitCrew1AvgStopRank > 0
    ? result.pitCrew1AvgStopRank
    : 22;
  const pc2Rank = result.pitCrew2AvgStopRank != null && result.pitCrew2AvgStopRank > 0
    ? result.pitCrew2AvgStopRank
    : 22;
  const pitCrewAvgRank = Math.floor((pc1Rank + pc2Rank) / 2);
  const pitCrewBonus   = PIT_CREW_AVG_RANK_BONUS[Math.min(22, Math.max(1, pitCrewAvgRank))] ?? 0.28;

  // Qualifying streak: both drivers top 10 in qualifying
  const bothQualTop10 =
    result.driver1QualifyingPosition != null && result.driver1QualifyingPosition <= 10 &&
    result.driver2QualifyingPosition != null && result.driver2QualifyingPosition <= 10;

  const incrementedQualStreak = bothQualTop10 ? streakState.qualifyingStreak + 1 : 0;
  const qualifyingStreakBonus  = incrementedQualStreak === STREAK_LENGTH ? QUALIFYING_STREAK_BONUS : 0;
  const newQualStreak          = incrementedQualStreak === STREAK_LENGTH ? 0 : incrementedQualStreak;

  // Race streak: both drivers top 10 in race
  const bothRaceTop10 =
    result.driver1FinishPosition != null && result.driver1FinishPosition <= 10 &&
    result.driver2FinishPosition != null && result.driver2FinishPosition <= 10;

  const incrementedRaceStreak = bothRaceTop10 ? streakState.raceStreak + 1 : 0;
  const raceStreakBonus        = incrementedRaceStreak === STREAK_LENGTH ? RACE_STREAK_BONUS : 0;
  const newRaceStreak          = incrementedRaceStreak === STREAK_LENGTH ? 0 : incrementedRaceStreak;

  const total = Math.round((driverAvgPoints + pitCrewBonus + qualifyingStreakBonus + raceStreakBonus) * 100) / 100;

  return {
    score: {
      teamName: result.teamName,
      driverAvgPoints,
      pitCrewAvgRank,
      pitCrewBonus,
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
