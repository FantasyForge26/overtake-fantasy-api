interface AssetForOTF {
  otfBaseRating: number;
  racesCompleted: number;
  avgPointsPerRace: number;
  totalPoints: number;
  age?: number;
  teamStrength: number;
  dnfCount: number;
}

export function calculateOTFRating(asset: AssetForOTF): number {
  if (asset.racesCompleted === 0) return asset.otfBaseRating;

  const performanceScore = Math.min(asset.avgPointsPerRace * 5, 50);
  const volumeScore = Math.min(asset.totalPoints / 500, 1) * 20;
  const ageBoost = asset.age
    ? asset.age < 25 ? 8 : asset.age < 28 ? 5 : asset.age < 32 ? 2 : 0
    : 0;
  const teamBoost = (asset.teamStrength / 100) * 10;
  const reliabilityScore =
    asset.racesCompleted > 0
      ? ((asset.racesCompleted - asset.dnfCount) / asset.racesCompleted) * 10
      : 5;

  return Math.min(99, Math.max(1, Math.round(
    performanceScore + volumeScore + ageBoost + teamBoost + reliabilityScore,
  )));
}
