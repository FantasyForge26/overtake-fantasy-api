import { calculateAllSprintScores, SprintResult, SprintScore } from './sprint';
import { calculateAllQualifyingDriverScores, QualifyingDriverResult, QualifyingDriverScore } from './qualifying';
import { calculateAllRaceDriverScores, RaceDriverResult, RaceDriverScore } from './race';
import { calculateAllPrincipalScores, PrincipalRaceResult, PrincipalScore, PrincipalStreakState } from './principal';
import { calculateAllPitCrewScores, CarPitData, PitCrewScore } from './pitcrew';
import { calculatePowerUnitScores, CarFinishData, PowerUnitScore } from './powerunit';

export type {
  SprintResult, SprintScore,
  QualifyingDriverResult, QualifyingDriverScore,
  RaceDriverResult, RaceDriverScore,
  PrincipalRaceResult, PrincipalScore, PrincipalStreakState,
  CarPitData, PitCrewScore,
  CarFinishData, PowerUnitScore,
};

export interface RaceWeekendData {
  sessionKey:  number;
  meetingKey:  number;
  raceName:    string;
  hasSprint:   boolean;

  qualifyingResults: QualifyingDriverResult[];
  sprintResults?:    SprintResult[];
  raceResults:       RaceDriverResult[];

  principalResults: PrincipalRaceResult[];
  pitData:          CarPitData[];
  carFinishData:    CarFinishData[];
}

export interface RaceWeekendScores {
  sessionKey:  number;
  raceName:    string;
  qualifying:  QualifyingDriverScore[];
  sprint?:     SprintScore[];
  race:        RaceDriverScore[];
  principals:  PrincipalScore[];
  pitCrews:    PitCrewScore[];
  powerUnits:  PowerUnitScore[];
}

export function calculateRaceWeekendScores(
  data: RaceWeekendData,
  principalStreakStates: Record<string, PrincipalStreakState>,
): { scores: RaceWeekendScores; newPrincipalStreakStates: Record<string, PrincipalStreakState> } {
  const qualifying = calculateAllQualifyingDriverScores(data.qualifyingResults);

  const sprint = data.hasSprint && data.sprintResults
    ? calculateAllSprintScores(data.sprintResults)
    : undefined;

  const race = calculateAllRaceDriverScores(data.raceResults);

  // Compute pit crew scores first — principal scoring depends on avg stop ranks
  const pitCrews = calculateAllPitCrewScores(data.pitData);

  // Build teamName → [avgStopRank, ...] map so principal can consume pit crew ranks
  const teamPitRanks = new Map<string, number[]>();
  for (let i = 0; i < data.pitData.length; i++) {
    const { teamName } = data.pitData[i];
    // avgStopRank === 0 means no stops; principal.ts converts 0/null to 22
    const rank = pitCrews[i]?.avgStopRank ?? 0;
    const arr = teamPitRanks.get(teamName) ?? [];
    arr.push(rank);
    teamPitRanks.set(teamName, arr);
  }

  // Enrich principalResults with pit crew avg stop ranks
  const enrichedPrincipalResults: PrincipalRaceResult[] = data.principalResults.map(pr => {
    const ranks = teamPitRanks.get(pr.teamName) ?? [];
    return {
      ...pr,
      pitCrew1AvgStopRank: ranks[0] ?? null,
      pitCrew2AvgStopRank: ranks[1] ?? null,
    };
  });

  const { scores: principals, newStreakStates: newPrincipalStreakStates } =
    calculateAllPrincipalScores(enrichedPrincipalResults, principalStreakStates);

  const powerUnits = calculatePowerUnitScores(data.carFinishData);

  return {
    scores: {
      sessionKey: data.sessionKey,
      raceName:   data.raceName,
      qualifying,
      sprint,
      race,
      principals,
      pitCrews,
      powerUnits,
    },
    newPrincipalStreakStates,
  };
}
