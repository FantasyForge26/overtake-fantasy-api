import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { Asset, League, Roster, HistoricalSeason } from '@/lib/models';
import { buildRaceWeekendData } from '@/lib/scoring/openf1';
import { calculateRaceWeekendScores, PrincipalStreakState } from '@/lib/scoring/index';
import { calculateOTFRating } from '@/lib/otf-calculator';

const POWER_UNIT_MAP: Record<string, string> = {
  'Red Bull Racing': 'ford-red-bull',
  'Racing Bulls':    'ford-red-bull',
  'Cadillac':        'ford-red-bull',
  'Mercedes':        'mercedes-amg',
  'McLaren':         'mercedes-amg',
  'Williams':        'mercedes-amg',
  'Ferrari':         'ferrari',
  'Haas':            'ferrari',
  'Aston Martin':    'honda',
  'Alpine':          'renault',
  'Audi':            'audi',
};

function pitCrewCarNumber(slug: string): number {
  const m = slug.match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

export async function POST(req: NextRequest) {
  if (req.headers.get('x-admin-key') !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { meetingKey } = await req.json();
  if (!meetingKey) {
    return NextResponse.json({ error: 'meetingKey is required' }, { status: 400 });
  }

  await connectDB();

  // -------------------------------------------------------------------------
  // 1. Build race weekend data from OpenF1
  // -------------------------------------------------------------------------
  let weekendData;
  try {
    weekendData = await buildRaceWeekendData(meetingKey, POWER_UNIT_MAP);
  } catch (err: any) {
    return NextResponse.json({ error: `OpenF1 fetch failed: ${err.message}` }, { status: 502 });
  }

  // -------------------------------------------------------------------------
  // 2. Load principal streak states from DB (stored on assets or a simple map)
  //    We use the principal asset's teamSlug as key.
  // -------------------------------------------------------------------------
  const principalAssets = await Asset.find({ season: 2026, assetType: 'principal', isActive: true }).lean() as any[];
  const streakStates: Record<string, PrincipalStreakState> = {};
  for (const pa of principalAssets) {
    streakStates[pa.team ?? pa.teamSlug] = {
      qualifyingStreak: pa.qualifyingStreak ?? 0,
      raceStreak:       pa.raceStreak ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // 3. Calculate all scores
  // -------------------------------------------------------------------------
  const { scores, newPrincipalStreakStates } = calculateRaceWeekendScores(weekendData, streakStates);

  // -------------------------------------------------------------------------
  // 4. Build lookup maps from scores
  // -------------------------------------------------------------------------

  // Drivers: driverNumber → total score (qual + sprint + race)
  const driverScoreByNum = new Map<number, number>();
  for (const q of scores.qualifying) {
    driverScoreByNum.set(q.driverNumber, (driverScoreByNum.get(q.driverNumber) ?? 0) + q.total);
  }
  if (scores.sprint) {
    for (const s of scores.sprint) {
      driverScoreByNum.set(s.driverNumber, (driverScoreByNum.get(s.driverNumber) ?? 0) + s.total);
    }
  }
  for (const r of scores.race) {
    driverScoreByNum.set(r.driverNumber, (driverScoreByNum.get(r.driverNumber) ?? 0) + r.total);
  }

  // Principals: teamName → score
  const principalScoreByTeam = new Map<string, number>();
  for (const p of scores.principals) {
    principalScoreByTeam.set(p.teamName, p.total);
  }

  // Pit crews: carNumber → score
  const pitCrewScoreByNum = new Map<number, number>();
  for (const pc of scores.pitCrews) {
    pitCrewScoreByNum.set(pc.carNumber, pc.total);
  }

  // Power units: manufacturer → score
  const puScoreByManufacturer = new Map<string, number>();
  for (const pu of scores.powerUnits) {
    puScoreByManufacturer.set(pu.manufacturer, pu.points);
  }

  // Driver car number map: look up from weekendData race results
  const carNumByDriverSlug = new Map<string, number>();
  for (const r of weekendData.raceResults) {
    carNumByDriverSlug.set(String(r.driverNumber), r.driverNumber);
  }

  // -------------------------------------------------------------------------
  // 5. Load all 2026 assets for lookup
  // -------------------------------------------------------------------------
  const allAssets: any[] = await Asset.find({ season: 2026, isActive: true }).lean();
  const assetById = new Map<string, any>(allAssets.map(a => [a._id.toString(), a]));

  // Build driver asset → car number mapping
  const assetCarNum = new Map<string, number>(); // assetId → carNumber
  for (const a of allAssets) {
    if (a.assetType === 'driver' && a.carNumber) {
      assetCarNum.set(a._id.toString(), a.carNumber);
    }
  }

  // -------------------------------------------------------------------------
  // 6. Score each league's rosters
  // -------------------------------------------------------------------------
  const activeLeagues = await League.find({ status: 'active' });
  let rostersUpdated = 0;
  const leagueSummaries: { leagueId: string; rostersScored: number }[] = [];

  for (const league of activeLeagues) {
    const leagueId = league._id.toString();
    const rosters = await Roster.find({ leagueId, season: 2026 });
    if (!rosters.length) continue;

    let rostersScored = 0;

    for (const roster of rosters) {
      let racePoints = 0;

      const d1 = roster.driver1AssetId ? assetById.get(roster.driver1AssetId.toString()) : null;
      const d2 = roster.driver2AssetId ? assetById.get(roster.driver2AssetId.toString()) : null;
      const pr = roster.principalAssetId ? assetById.get(roster.principalAssetId.toString()) : null;
      const pc1 = roster.pitCrew1AssetId ? assetById.get(roster.pitCrew1AssetId.toString()) : null;
      const pc2 = roster.pitCrew2AssetId ? assetById.get(roster.pitCrew2AssetId.toString()) : null;
      const pu = roster.powerUnitAssetId ? assetById.get(roster.powerUnitAssetId.toString()) : null;

      if (d1?.carNumber) racePoints += driverScoreByNum.get(d1.carNumber) ?? 0;
      if (d2?.carNumber) racePoints += driverScoreByNum.get(d2.carNumber) ?? 0;
      if (pr?.team)      racePoints += principalScoreByTeam.get(pr.team) ?? 0;
      if (pc1) {
        const cn = pc1.carNumber ?? pitCrewCarNumber(pc1.slug ?? '');
        racePoints += pitCrewScoreByNum.get(cn) ?? 0;
      }
      if (pc2) {
        const cn = pc2.carNumber ?? pitCrewCarNumber(pc2.slug ?? '');
        racePoints += pitCrewScoreByNum.get(cn) ?? 0;
      }
      if (pu?.manufacturer) racePoints += puScoreByManufacturer.get(pu.manufacturer) ?? 0;

      racePoints = Math.round(racePoints * 100) / 100;
      roster.totalPoints = Math.round(((roster.totalPoints ?? 0) + racePoints) * 100) / 100;
      roster.updatedAt   = new Date();
      await roster.save();
      rostersScored++;
      rostersUpdated++;
    }

    // Refresh season ranks within league
    const ranked = [...rosters].sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
    for (let i = 0; i < ranked.length; i++) {
      ranked[i].seasonRank = i + 1;
      await ranked[i].save();
    }

    leagueSummaries.push({ leagueId, rostersScored });
  }

  // -------------------------------------------------------------------------
  // 7. Update asset stats (global, not per-league)
  // -------------------------------------------------------------------------
  const assetUpdates: string[] = [];

  for (const asset of allAssets) {
    let score = 0;
    let scored = false;

    if (asset.assetType === 'driver' && asset.carNumber) {
      score  = driverScoreByNum.get(asset.carNumber) ?? 0;
      scored = driverScoreByNum.has(asset.carNumber);
    } else if (asset.assetType === 'principal' && asset.team) {
      score  = principalScoreByTeam.get(asset.team) ?? 0;
      scored = principalScoreByTeam.has(asset.team);
    } else if (asset.assetType === 'pitCrew') {
      const cn = asset.carNumber ?? pitCrewCarNumber(asset.slug ?? '');
      score  = pitCrewScoreByNum.get(cn) ?? 0;
      scored = pitCrewScoreByNum.has(cn);
    } else if (asset.assetType === 'powerUnit' && asset.manufacturer) {
      score  = puScoreByManufacturer.get(asset.manufacturer) ?? 0;
      scored = puScoreByManufacturer.has(asset.manufacturer);
    }

    if (!scored) continue;

    const newTotal       = Math.round(((asset.totalPoints ?? 0) + score) * 100) / 100;
    const newRaces       = (asset.racesCompleted ?? 0) + 1;
    const newAvg         = Math.round((newTotal / newRaces) * 100) / 100;

    // Recalculate OTF
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

    const newOtfRating = calculateOTFRating({
      otfBaseRating:    asset.otfBaseRating ?? 50,
      racesCompleted:   newRaces,
      avgPointsPerRace: newAvg,
      totalPoints:      newTotal,
      age:              asset.age,
      teamStrength:     asset.teamStrength ?? 50,
      dnfCount:         asset.dnfCount ?? 0,
      assetType:        asset.assetType,
      championshipWins: asset.championshipWins,
      historicalSeasons,
    });

    await Asset.findByIdAndUpdate(asset._id, {
      totalPoints:      newTotal,
      racesCompleted:   newRaces,
      avgPointsPerRace: newAvg,
      otfRating:        newOtfRating,
    });

    assetUpdates.push(asset.slug);
  }

  // -------------------------------------------------------------------------
  // 8. Persist updated principal streak states
  // -------------------------------------------------------------------------
  for (const [teamName, newStreak] of Object.entries(newPrincipalStreakStates)) {
    await Asset.findOneAndUpdate(
      { season: 2026, assetType: 'principal', team: teamName },
      { $set: { qualifyingStreak: newStreak.qualifyingStreak, raceStreak: newStreak.raceStreak } },
    );
  }

  return NextResponse.json({
    success:       true,
    raceName:      scores.raceName,
    hasSprint:     weekendData.hasSprint,
    assetsUpdated: assetUpdates.length,
    rostersUpdated,
    leagues:       leagueSummaries,
  });
}
