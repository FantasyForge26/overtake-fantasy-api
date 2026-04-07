import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { connectDB } from '@/lib/db';
import { RaceResult, Asset, RaceCalendar } from '@/lib/models';
import { getMobileSession } from '@/lib/mobile-auth';
import { FINISH_POINTS, calculateDriverQualifyingScore } from '@/lib/otf-calculator';

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

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: leagueId } = await params;
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug is required' }, { status: 400 });

  await connectDB();

  const asset = await Asset.findOne({ slug }).lean() as any;
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const teammate = await Asset.findOne({
    teamSlug: asset.teamSlug,
    assetType: 'driver',
    slug: { $ne: slug },
  }).lean() as any;

  const raceResults = await RaceResult.find({ leagueId, season: 2026 }).sort({ round: 1 }).lean() as any[];

  const calendar = await RaceCalendar.find({ season: 2026 }).lean() as any[];
  const calByRound: Record<number, any> = {};
  for (const r of calendar) calByRound[r.round] = r;

  const rows: any[] = [];

  for (const rr of raceResults) {
    const myResult = (rr.driverResults ?? []).find((d: any) => d.driverSlug === slug);
    if (!myResult) continue;

    const cal = calByRound[rr.round];
    const flag = cal ? (COUNTRY_FLAGS[cal.country] ?? '🏁') : '🏁';
    const shortName = cal?.country ?? `R${rr.round}`;

    const teammateResult = teammate
      ? (rr.driverResults ?? []).find((d: any) => d.driverSlug === teammate.slug)
      : null;

    // ── Qualifying ──────────────────────────────────────────────────────────
    // Use stored qualifyingPosition if present; fall back to startPosition as proxy
    const qPos: number = myResult.qualifyingPosition ?? myResult.startPosition ?? 20;
    const qHasExactData = myResult.qualifyingPosition != null;
    const qStage = deriveQStage(qPos);
    const teammateQPos: number = teammateResult?.qualifyingPosition ?? teammateResult?.startPosition ?? 20;
    const qBeatenTeammate = qPos < teammateQPos;

    let qPts: number | null = null;
    if (rr.qualifyingScored || qHasExactData) {
      qPts = calculateDriverQualifyingScore({
        qualifyingPosition: qPos,
        qualifyingRound: qStage,
        beatenTeammate: qBeatenTeammate,
        didNotQualify: false,
        dsqFromQualifying: false,
      });
    }

    // ── DNF / not classified ─────────────────────────────────────────────────
    if (myResult.notClassified || myResult.dnf) {
      const rPts = myResult.notClassified ? -15 : 0;
      rows.push({
        round: rr.round, flag, shortName,
        qPts, qStage, qPos, qApprox: !qHasExactData,
        rPts, spPts: null, flBonus: 0, btBonus: 0, pgScore: 0,
        total: (qPts ?? 0) + rPts, dnf: true,
      });
      continue;
    }

    // ── Race ─────────────────────────────────────────────────────────────────
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
      qPts, qStage, qPos, qApprox: !qHasExactData,
      rPts, spPts: null, flBonus, btBonus, pgScore, total, dnf: false,
    });
  }

  // Season totals
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

  // Q stage counts
  const qCounts = { Q3: 0, Q2: 0, Q1: 0 };
  for (const r of rows) if (r.qStage) qCounts[r.qStage as 'Q1'|'Q2'|'Q3']++;

  return NextResponse.json({ rows, totals, qCounts });
}
