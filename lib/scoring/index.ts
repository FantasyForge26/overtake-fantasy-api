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

  const { scores: principals, newStreakStates: newPrincipalStreakStates } =
    calculateAllPrincipalScores(data.principalResults, principalStreakStates);

  const pitCrews  = calculateAllPitCrewScores(data.pitData);
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
