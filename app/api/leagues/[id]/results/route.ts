import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { League, Roster, Asset, RaceResult, PerformanceSelection, Transaction } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import {
  calculateDriverScore,
  calculatePrincipalScore,
  calculatePitCrewScore,
  calculatePowerUnitScore,
} from '@/lib/otf-calculator';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: leagueId } = await params;
  const round = parseInt(req.nextUrl.searchParams.get('round') ?? '0', 10);

  await connectDB();

  const result = await RaceResult.findOne({ leagueId, season: 2026, round });
  return NextResponse.json(result ?? null);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = (session.user as any).id as string;
  const { id: leagueId } = await params;

  await connectDB();

  const league = await League.findById(leagueId);
  if (!league) return NextResponse.json({ error: 'League not found' }, { status: 404 });
  if (league.commissionerId.toString() !== userId) {
    return NextResponse.json({ error: 'Only the commissioner can enter results' }, { status: 403 });
  }

  const { round, driverResults, pitCrewResults } = await req.json();

  // Upsert race result document
  await RaceResult.findOneAndUpdate(
    { leagueId, season: 2026, round },
    { driverResults, pitCrewResults, enteredBy: userId, enteredAt: new Date(), calculated: false },
    { upsert: true },
  );

  // Build lookup maps from the submitted results
  const driverMap: Record<string, typeof driverResults[0]> = {};
  for (const dr of driverResults) driverMap[dr.driverSlug] = dr;

  const pitCrewMap: Record<string, typeof pitCrewResults[0]> = {};
  for (const pc of pitCrewResults) pitCrewMap[pc.pitCrewSlug] = pc;

  // Load all rosters for the league
  const rosters = await Roster.find({ leagueId });

  // Load all assets referenced by any roster in one query
  const assetIds = new Set<string>();
  for (const r of rosters) {
    for (const field of ['driver1AssetId', 'driver2AssetId', 'principalAssetId', 'pitCrew1AssetId', 'pitCrew2AssetId', 'powerUnitAssetId'] as const) {
      if (r[field]) assetIds.add(r[field].toString());
    }
  }
  const assets = await Asset.find({ _id: { $in: Array.from(assetIds) } }).lean() as any[];
  const assetById: Record<string, any> = {};
  for (const a of assets) assetById[a._id.toString()] = a;

  // Build a teamSlug → [finishPositions] map for power unit scoring
  const teamFinishes: Record<string, number[]> = {};
  for (const dr of driverResults) {
    if (dr.dnf || dr.notClassified || !dr.finishPosition) continue;
    // Find the asset for this driver slug to get teamSlug
    const asset = assets.find((a: any) => a.slug === dr.driverSlug);
    if (!asset) continue;
    const key = asset.teamSlug;
    if (!teamFinishes[key]) teamFinishes[key] = [];
    teamFinishes[key].push(dr.finishPosition);
  }

  // Build a principalTeamSlug → [both driver finish positions] map
  const principalTeamFinishes: Record<string, number[]> = {};
  for (const dr of driverResults) {
    if (dr.dnf || dr.notClassified || !dr.finishPosition) continue;
    const asset = assets.find((a: any) => a.slug === dr.driverSlug);
    if (!asset) continue;
    if (!principalTeamFinishes[asset.teamSlug]) principalTeamFinishes[asset.teamSlug] = [];
    principalTeamFinishes[asset.teamSlug].push(dr.finishPosition);
  }

  // Load all perf selections for this round
  const perfSelections = await PerformanceSelection.find({ leagueId, season: 2026, round }).lean() as any[];
  const perfByUser: Record<string, any> = {};
  for (const ps of perfSelections) perfByUser[ps.userId] = ps;

  const scores: { userId: string; totalRacePoints: number }[] = [];

  for (const roster of rosters) {
    const rUserId = roster.userId.toString();
    const perf = perfByUser[rUserId];

    const d1 = assetById[roster.driver1AssetId?.toString()];
    const d2 = assetById[roster.driver2AssetId?.toString()];
    const principal = assetById[roster.principalAssetId?.toString()];
    const pc1 = assetById[roster.pitCrew1AssetId?.toString()];
    const pc2 = assetById[roster.pitCrew2AssetId?.toString()];
    const pu = assetById[roster.powerUnitAssetId?.toString()];

    let racePoints = 0;

    // Driver 1
    if (d1) {
      const dr = driverMap[d1.slug];
      if (dr) {
        const teamDrivers = driverResults.filter((x: any) => {
          const a = assets.find((a: any) => a.slug === x.driverSlug);
          return a?.teamSlug === d1.teamSlug && x.driverSlug !== d1.slug;
        });
        const teammateFinish = teamDrivers[0]?.finishPosition ?? 20;
        let pts = calculateDriverScore({
          finishPosition: dr.finishPosition ?? 20,
          startPosition: dr.startPosition ?? 20,
          teammateFinishPosition: teammateFinish,
          fastestLap: dr.fastestLap ?? false,
          speedTrapViolation: dr.speedTrapViolation ?? false,
          notClassified: dr.notClassified ?? false,
          dnf: dr.dnf ?? false,
          penalizedSeconds: dr.penalizedSeconds ?? 0,
        });
        if (perf?.driver1Boost?.toString() === d1._id.toString()) pts *= 2;
        racePoints += pts;
      }
    }

    // Driver 2
    if (d2) {
      const dr = driverMap[d2.slug];
      if (dr) {
        const teamDrivers = driverResults.filter((x: any) => {
          const a = assets.find((a: any) => a.slug === x.driverSlug);
          return a?.teamSlug === d2.teamSlug && x.driverSlug !== d2.slug;
        });
        const teammateFinish = teamDrivers[0]?.finishPosition ?? 20;
        let pts = calculateDriverScore({
          finishPosition: dr.finishPosition ?? 20,
          startPosition: dr.startPosition ?? 20,
          teammateFinishPosition: teammateFinish,
          fastestLap: dr.fastestLap ?? false,
          speedTrapViolation: dr.speedTrapViolation ?? false,
          notClassified: dr.notClassified ?? false,
          dnf: dr.dnf ?? false,
          penalizedSeconds: dr.penalizedSeconds ?? 0,
        });
        if (perf?.driver2Boost?.toString() === d2._id.toString()) pts *= 2;
        racePoints += pts;
      }
    }

    // Principal — uses both drivers' finish positions for that constructor
    if (principal) {
      const teamPositions = principalTeamFinishes[principal.teamSlug] ?? [];
      const [pos1 = 20, pos2 = 20] = teamPositions;
      racePoints += calculatePrincipalScore(pos1, pos2);
    }

    // Pit crew 1
    if (pc1) {
      const pcr = pitCrewMap[pc1.slug];
      if (pcr) {
        let pts = calculatePitCrewScore(pcr.stopTimes ?? [], pcr.fastestStopOverall ?? false);
        if (perf?.pitCrew1Boost?.toString() === pc1._id.toString()) pts *= 2;
        racePoints += pts;
      }
    }

    // Pit crew 2
    if (pc2) {
      const pcr = pitCrewMap[pc2.slug];
      if (pcr) {
        let pts = calculatePitCrewScore(pcr.stopTimes ?? [], pcr.fastestStopOverall ?? false);
        if (perf?.pitCrew2Boost?.toString() === pc2._id.toString()) pts *= 2;
        racePoints += pts;
      }
    }

    // Power unit — avg finish of all cars running this manufacturer
    if (pu) {
      const finishes = teamFinishes[pu.teamSlug] ?? [];
      if (finishes.length > 0) {
        const avg = finishes.reduce((s, p) => s + p, 0) / finishes.length;
        racePoints += calculatePowerUnitScore(avg);
      }
    }

    racePoints = Math.round(racePoints * 100) / 100;

    roster.totalPoints = (roster.totalPoints ?? 0) + racePoints;
    roster.updatedAt = new Date();
    await roster.save();

    await Transaction.create({
      leagueId,
      userId: rUserId,
      type: 'race',
      createdAt: new Date(),
      // store points in a note field — extend schema if needed
    });

    scores.push({ userId: rUserId, totalRacePoints: racePoints });
  }

  // Update season ranks
  const sorted = [...rosters].sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
  for (let i = 0; i < sorted.length; i++) {
    sorted[i].seasonRank = i + 1;
    await sorted[i].save();
  }

  // Mark result as calculated
  await RaceResult.findOneAndUpdate(
    { leagueId, season: 2026, round },
    { calculated: true },
  );

  return NextResponse.json({ success: true, scores });
}
