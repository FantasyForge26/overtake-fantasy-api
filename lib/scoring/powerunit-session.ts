export type SessionType = 'sprintQuali' | 'sprintRace' | 'qualifying' | 'race';

const SESSION_WEIGHTS: Record<SessionType, number> = {
  sprintQuali: 0.25,
  sprintRace:  0.25,
  qualifying:  0.25,
  race:        0.75,
};

const DNF_POSITION = 22;

// Same rankBonus formula as existing powerunit.ts (must stay in sync)
function rankBonus(rank: number): number {
  return Math.max(0.114, 11.375 - ((rank - 1) * 0.56875));
}

export interface CarSessionData {
  driverNumber: number;
  manufacturer: string;
  position:     number | null; // null = DNF/DNQ -> treated as P22
}

export interface PowerUnitSessionResult {
  manufacturer: string;
  session:      SessionType;
  avgPosition:  number;
  rank:         number;
  rawPoints:    number;
  points:       number;
}

export function calculatePowerUnitSessionScores(
  allCars: CarSessionData[],
  session: SessionType,
): PowerUnitSessionResult[] {
  const byManufacturer = new Map<string, number[]>();
  for (const car of allCars) {
    const pos = car.position ?? DNF_POSITION;
    const arr = byManufacturer.get(car.manufacturer) ?? [];
    arr.push(pos);
    byManufacturer.set(car.manufacturer, arr);
  }
  const averages = Array.from(byManufacturer.entries()).map(([manufacturer, positions]) => ({
    manufacturer,
    avgPosition: Math.round((positions.reduce((a, b) => a + b, 0) / positions.length) * 100) / 100,
  }));
  averages.sort((a, b) => a.avgPosition - b.avgPosition);
  const weight = SESSION_WEIGHTS[session];
  return averages.map(({ manufacturer, avgPosition }, i) => {
    const rank = i + 1;
    const rawPoints = rankBonus(rank);
    return {
      manufacturer,
      session,
      avgPosition,
      rank,
      rawPoints,
      points: Math.round(rawPoints * weight * 100) / 100,
    };
  });
}
