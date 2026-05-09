export type SessionType = 'sprintQuali' | 'sprintRace' | 'qualifying' | 'race';

const SESSION_WEIGHTS: Record<SessionType, number> = {
  sprintQuali: 0.25,
  sprintRace:  0.25,
  qualifying:  0.25,
  race:        0.75,
};

const DNF_POSITION = 22;

// Position bonus tables — must stay in sync with qualifying.ts, sprint.ts, race.ts
const QUALIFYING_POSITION_BONUS: Record<number, number> = {
   1: 13.63,  2: 13.01,  3: 12.38,  4: 11.77,  5: 11.14,
   6: 10.53,  7:  9.90,  8:  9.29,  9:  8.66, 10:  8.05,
  11:  7.42, 12:  6.80, 13:  6.17, 14:  5.56, 15:  4.95,
  16:  4.32, 17:  3.71, 18:  3.10, 19:  2.47, 20:  1.85,
  21:  1.24, 22:  0.61,
};

const SPRINT_POSITION_BONUS: Record<number, number> = {
   1: 9.54,  2: 9.14,  3: 8.73,  4: 8.32,  5: 7.90,
   6: 7.51,  7: 7.09,  8: 6.68,  9: 6.26, 10: 5.87,
  11: 5.45, 12: 5.04, 13: 4.63, 14: 4.23, 15: 3.82,
  16: 3.42, 17: 3.01, 18: 2.59, 19: 2.18, 20: 1.78,
  21: 1.37, 22: 0.95,
};

const RACE_POSITION_BONUS: Record<number, number> = {
   1: 34.04,  2: 32.49,  3: 30.94,  4: 29.39,  5: 27.85,
   6: 26.30,  7: 24.75,  8: 23.20,  9: 21.65, 10: 20.11,
  11: 18.56, 12: 17.01, 13: 15.46, 14: 13.91, 15: 12.37,
  16: 10.82, 17:  9.27, 18:  7.72, 19:  6.17, 20:  4.63,
  21:  3.08, 22:  1.53,
};

export interface PrincipalSessionInput {
  teamName:        string;
  driver1Position: number | null; // null = DNF/DNQ -> treated as P22
  driver2Position: number | null;
  session:         SessionType;
}

export interface PrincipalSessionResult {
  teamName:    string;
  session:     SessionType;
  avgPosition: number;
  rawPoints:   number; // unweighted table lookup
  points:      number; // rawPoints * weight, rounded 2dp
}

function getPositionTable(session: SessionType): Record<number, number> {
  switch (session) {
    case 'sprintQuali': return QUALIFYING_POSITION_BONUS;
    case 'sprintRace':  return SPRINT_POSITION_BONUS;
    case 'qualifying':  return QUALIFYING_POSITION_BONUS;
    case 'race':        return RACE_POSITION_BONUS;
  }
}

export function calculatePrincipalSessionScore(input: PrincipalSessionInput): PrincipalSessionResult {
  const d1 = input.driver1Position ?? DNF_POSITION;
  const d2 = input.driver2Position ?? DNF_POSITION;
  const rawAvg = (d1 + d2) / 2;
  const avgPosition = Math.min(22, Math.max(1, Math.round(rawAvg)));
  const table = getPositionTable(input.session);
  const rawPoints = table[avgPosition] ?? 0;
  const weight = SESSION_WEIGHTS[input.session];
  const points = Math.round(rawPoints * weight * 100) / 100;
  return {
    teamName: input.teamName,
    session:  input.session,
    avgPosition,
    rawPoints,
    points,
  };
}
