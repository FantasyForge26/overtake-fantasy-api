import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { Asset, RaceResult, RaceCalendar } from '@/lib/models';
import { FINISH_POINTS } from '@/lib/otf-calculator';

const COUNTRY_FLAGS: Record<string, string> = {
  'Australia': '🇦🇺', 'China': '🇨🇳', 'Japan': '🇯🇵',
  'Bahrain': '🇧🇭', 'Saudi Arabia': '🇸🇦', 'USA': '🇺🇸',
  'Canada': '🇨🇦', 'Monaco': '🇲🇨', 'Spain': '🇪🇸',
  'Austria': '🇦🇹', 'UK': '🇬🇧', 'Belgium': '🇧🇪',
  'Hungary': '🇭🇺', 'Netherlands': '🇳🇱', 'Italy': '🇮🇹',
  'Azerbaijan': '🇦🇿', 'Singapore': '🇸🇬', 'Mexico': '🇲🇽',
  'Brazil': '🇧🇷', 'Qatar': '🇶🇦', 'Abu Dhabi': '🇦🇪',
};

function deriveQStage(pos: number): 'Q1' | 'Q2' | 'Q3' {
  if (pos <= 10) return 'Q3';
  if (pos <= 15) return 'Q2';
  return 'Q1';
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { slug } = await params;
  const seasonParam = req.nextUrl.searchParams.get('season');
  const season = seasonParam ? parseInt(seasonParam, 10) : 2026;

  // Gate: only 2026 for now; extend this list as historical data is backfilled
  if (season !== 2026) {
    return NextResponse.json({ error: 'season must be 2026' }, { status: 400 });
  }

  await connectDB();

  const asset = await Asset.findOne({ slug }).lean() as any;
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  // For drivers: find their teammate for beat-teammate bonus
  const teammate = asset.assetType === 'driver'
    ? await Asset.findOne({ teamSlug: asset.teamSlug, assetType: 'driver', slug: { $ne: slug } }).lean() as any
    : null;

  // Race calendar for flags/names
  const calendar = await RaceCalendar.find({ season }).lean() as any[];
  const calByRound: Record<number, any> = {};
  for (const r of calendar) calByRound[r.round] = r;

  // Fetch one RaceResult per round across all leagues (data is identical across leagues)
  const allResults = await RaceResult.find({ season }).sort({ round: 1 }).lean() as any[];

  // Deduplicate by round — keep the first result found for each round
  const byRound = new Map<number, any>();
  for (const rr of allResults) {
    if (!byRound.has(rr.round)) byRound.set(rr.round, rr);
  }

  const rows: any[] = [];

  for (const [, rr] of [...byRound.entries()].sort(([a], [b]) => a - b)) {
    const myResult = (rr.driverResults ?? []).find((d: any) => d.driverSlug === slug);
    if (!myResult) continue;

    const cal = calByRound[rr.round];
    const flag = cal ? (COUNTRY_FLAGS[cal.country] ?? '🏁') : '🏁';
    const shortName = cal?.country ?? `R${rr.round}`;

    const teammateResult = teammate
      ? (rr.driverResults ?? []).find((d: any) => d.driverSlug === teammate.slug)
      : null;

    // Derive Q-stage from startPosition (proxy for qualifying position)
    const qPos: number = myResult.qualifyingPosition ?? myResult.startPosition ?? 20;
    const qStage = deriveQStage(qPos);

    // qPts only when qualifyingScored or exact qualifying position is stored
    const qHasExactData = myResult.qualifyingPosition != null;
    let qPts: number | null = null;
    if (rr.qualifyingScored || qHasExactData) {
      // Basic qualifying points from position (simplified — no teammate comparison available here)
      qPts = null; // leave null; full calculation requires teammate data from OpenF1
    }

    if (myResult.notClassified || myResult.dnf) {
      const rPts = myResult.notClassified ? -15 : 0;
      rows.push({
        round: rr.round, flag, shortName,
        qPts, qStage, qPos,
        rPts, flBonus: 0, btBonus: 0, pgScore: 0,
        total: (qPts ?? 0) + rPts, dnf: true,
      });
      continue;
    }

    const finish = myResult.finishPosition ?? 20;
    const start  = myResult.startPosition  ?? 20;
    const teammateFinish = teammateResult?.finishPosition ?? 20;

    const rPts    = (FINISH_POINTS[finish] ?? 0) + 1;
    const flBonus = myResult.fastestLap ? 5 : 0;
    const btBonus = finish < teammateFinish ? 3 : 0;

    const delta = start - finish;
    let pgScore = 0;
    if (delta > 0) {
      pgScore = Math.min(delta * 2, 10);
    } else if (delta < 0) {
      const lost = -delta;
      pgScore = start <= 10 ? -Math.min(lost * 2, 10) : -Math.min(lost, 5);
    }

    const total = (qPts ?? 0) + rPts + flBonus + btBonus + pgScore;

    rows.push({
      round: rr.round, flag, shortName,
      qPts, qStage, qPos,
      rPts, flBonus, btBonus, pgScore, total, dnf: false,
    });
  }

  const totals = rows.reduce(
    (acc, r) => ({
      qPts:    acc.qPts    + (r.qPts ?? 0),
      rPts:    acc.rPts    + r.rPts,
      flBonus: acc.flBonus + r.flBonus,
      btBonus: acc.btBonus + r.btBonus,
      pgScore: acc.pgScore + r.pgScore,
      total:   acc.total   + r.total,
    }),
    { qPts: 0, rPts: 0, flBonus: 0, btBonus: 0, pgScore: 0, total: 0 },
  );

  const qCounts = { Q3: 0, Q2: 0, Q1: 0 };
  for (const r of rows) if (r.qStage) qCounts[r.qStage as 'Q1' | 'Q2' | 'Q3']++;

  return NextResponse.json({ rows, totals, qCounts, season });
}
