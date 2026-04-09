import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getMobileSession } from '@/lib/mobile-auth';
import { connectDB } from '@/lib/db';
import { HistoricalRaceBreakdown } from '@/lib/models';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = (await getServerSession(authOptions)) ?? (await getMobileSession(req));
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { slug } = await params;
  const seasonParam = req.nextUrl.searchParams.get('season');
  const season = seasonParam ? parseInt(seasonParam, 10) : null;

  if (season !== 2024 && season !== 2025) {
    return NextResponse.json({ error: 'season must be 2024 or 2025' }, { status: 400 });
  }

  await connectDB();

  const rows = await HistoricalRaceBreakdown.find({ assetSlug: slug, season })
    .sort({ round: 1 })
    .lean() as any[];

  if (!rows.length) {
    return NextResponse.json({ rows: [], totals: { rPts: 0, flBonus: 0, btBonus: 0, pgScore: 0, total: 0 }, qCounts: { Q3: 0, Q2: 0, Q1: 0 }, season });
  }

  const totals = rows.reduce(
    (acc, r) => ({
      rPts:    acc.rPts    + (r.rPts    ?? 0),
      flBonus: acc.flBonus + (r.flBonus ?? 0),
      btBonus: acc.btBonus + (r.btBonus ?? 0),
      pgScore: acc.pgScore + (r.pgScore ?? 0),
      total:   acc.total   + (r.tot     ?? 0),
    }),
    { rPts: 0, flBonus: 0, btBonus: 0, pgScore: 0, total: 0 },
  );

  const qCounts = { Q3: 0, Q2: 0, Q1: 0 };
  for (const r of rows) {
    if (r.qStage === 'Q3') qCounts.Q3++;
    else if (r.qStage === 'Q2') qCounts.Q2++;
    else if (r.qStage === 'Q1') qCounts.Q1++;
  }

  // Normalise field names to match what the client expects (tot → total)
  const normRows = rows.map(r => ({
    round:       r.round,
    flag:        r.flag ?? '🏁',
    shortName:   r.shortName ?? `R${r.round}`,
    qPos:        r.qPos ?? null,
    qStage:      r.qStage ?? null,
    qPts:        r.qPts ?? null,
    rPts:        r.rPts ?? 0,
    flBonus:     r.flBonus ?? 0,
    btBonus:     r.btBonus ?? 0,
    pgScore:     r.pgScore ?? 0,
    total:       r.tot ?? 0,
    dnf:         r.dnf ?? false,
    driver1Pos:  r.driver1Pos ?? null,
    driver2Pos:  r.driver2Pos ?? null,
    driver1Name: r.driver1Name ?? null,
    driver2Name: r.driver2Name ?? null,
    stopCount:         r.stopCount         ?? null,
    avgStopTime:       r.avgStopTime       ?? null,
    fastestStop:       r.fastestStop       ?? null,
    wasOverallFastest: r.wasOverallFastest ?? false,
    stop1Time:         r.stop1Time         ?? null,
    stop2Time:         r.stop2Time         ?? null,
    stop3Time:         r.stop3Time         ?? null,
    carPositions:      r.carPositions      ?? null,
  }));

  return NextResponse.json({ rows: normRows, totals, qCounts, season });
}
