const DNF_POSITION = 22;

// Points by rank: 25 - ((rank - 1) * 1.25), min 0.25
function rankBonus(rank: number): number {
  return Math.max(0.25, 25 - ((rank - 1) * 1.25));
}

export interface CarFinishData {
  driverNumber:  number;
  manufacturer:  string;
  finishPosition: number | null; // null = DNF, treated as 22
}

export interface PowerUnitScore {
  manufacturer:      string;
  avgFinishPosition: number;
  rank:              number;
  points:            number;
}

export function calculatePowerUnitScores(allCars: CarFinishData[]): PowerUnitScore[] {
  // Group by manufacturer
  const byManufacturer = new Map<string, number[]>();
  for (const car of allCars) {
    const pos = car.finishPosition ?? DNF_POSITION;
    const arr = byManufacturer.get(car.manufacturer) ?? [];
    arr.push(pos);
    byManufacturer.set(car.manufacturer, arr);
  }

  // Compute average finish per manufacturer
  const averages = Array.from(byManufacturer.entries()).map(([manufacturer, positions]) => {
    const avg = positions.reduce((a, b) => a + b, 0) / positions.length;
    return { manufacturer, avgFinishPosition: Math.round(avg * 100) / 100 };
  });

  // Rank ascending by average finish (lowest = best = rank 1)
  averages.sort((a, b) => a.avgFinishPosition - b.avgFinishPosition);

  return averages.map(({ manufacturer, avgFinishPosition }, i) => ({
    manufacturer,
    avgFinishPosition,
    rank:   i + 1,
    points: rankBonus(i + 1),
  }));
}
