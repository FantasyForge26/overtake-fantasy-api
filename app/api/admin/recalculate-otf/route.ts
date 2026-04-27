import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Asset, HistoricalSeason } from '@/lib/models';
import { calculateOTFRating } from '@/lib/otf-calculator';

export async function POST(req: NextRequest) {
  if (req.headers.get('x-admin-key') !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const assets = await Asset.find({ season: 2026, isActive: true });

  for (const asset of assets) {
    const historicalDocs = await HistoricalSeason.find({ assetSlug: asset.slug }).lean() as any[];
    const historicalSeasons = historicalDocs.map((h: any) => ({
      season:           h.season,
      wins:             h.wins ?? 0,
      podiums:          h.podiums ?? 0,
      racesCompleted:   h.racesCompleted ?? 0,
      q3Count:          h.q3Count ?? 0,
      qualifyingRaces:  h.qualifyingRaces ?? 0,
      dnfCount:         h.dnfCount ?? 0,
      avgPointsPerRace: h.avgPointsPerRace ?? 0,
      championshipWins: h.championshipWins ?? 0,
    }));

    asset.otfRating = calculateOTFRating({
      otfBaseRating:    asset.otfBaseRating,
      racesCompleted:   asset.racesCompleted ?? 0,
      avgPointsPerRace: asset.avgPointsPerRace ?? 0,
      totalPoints:      asset.totalPoints ?? 0,
      age:              asset.age,
      teamStrength:     asset.teamStrength ?? 50,
      dnfCount:         asset.dnfCount ?? 0,
      assetType:        asset.assetType,
      championshipWins: asset.championshipWins,
      historicalSeasons,
    });
    await asset.save();
  }

  return NextResponse.json({ updated: assets.length });
}
