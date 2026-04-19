// Points by rank: 9.75 - ((rank - 1) * 0.45), min 0.30
function rankBonus(rank: number): number {
  return Math.max(0.30, 9.75 - ((rank - 1) * 0.45));
}

export interface CarPitData {
  driverNumber: number;
  carNumber:    number;
  teamName:     string;
  pitStops:     number[]; // stop durations in seconds; empty = no stops
}

export interface PitCrewScore {
  driverNumber:    number;
  carNumber:       number;
  fastestStopRank: number; // 0 = no stops
  fastestStopBonus: number;
  avgStopRank:     number; // 0 = no stops
  avgStopBonus:    number;
  total:           number;
}

export function calculateAllPitCrewScores(allCars: CarPitData[]): PitCrewScore[] {
  // Compute per-car metrics (null = no stops)
  const metrics = allCars.map(car => ({
    driverNumber: car.driverNumber,
    carNumber:    car.carNumber,
    fastest: car.pitStops.length > 0 ? Math.min(...car.pitStops) : null,
    avg:     car.pitStops.length > 0
      ? car.pitStops.reduce((a, b) => a + b, 0) / car.pitStops.length
      : null,
  }));

  // Rank cars that have stops by fastest single stop (ascending)
  const withFastest = metrics
    .filter(m => m.fastest !== null)
    .sort((a, b) => a.fastest! - b.fastest!);
  const fastestRankMap = new Map<number, number>(
    withFastest.map((m, i) => [m.driverNumber, i + 1]),
  );

  // Rank cars that have stops by average stop time (ascending)
  const withAvg = metrics
    .filter(m => m.avg !== null)
    .sort((a, b) => a.avg! - b.avg!);
  const avgRankMap = new Map<number, number>(
    withAvg.map((m, i) => [m.driverNumber, i + 1]),
  );

  return allCars.map(car => {
    const fastestStopRank  = fastestRankMap.get(car.driverNumber) ?? 0;
    const avgStopRank      = avgRankMap.get(car.driverNumber) ?? 0;
    const fastestStopBonus = fastestStopRank > 0 ? rankBonus(fastestStopRank) : 0;
    const avgStopBonus     = avgStopRank > 0 ? rankBonus(avgStopRank) : 0;
    const total            = Math.round((fastestStopBonus + avgStopBonus) * 100) / 100;

    return {
      driverNumber: car.driverNumber,
      carNumber:    car.carNumber,
      fastestStopRank,
      fastestStopBonus,
      avgStopRank,
      avgStopBonus,
      total,
    };
  });
}
